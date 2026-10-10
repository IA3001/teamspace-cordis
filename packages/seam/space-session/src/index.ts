// seam/space-session —— 能力缝（capability seam）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 services/store/member.go、domain/principal.go、domain/dri_rotation.go）：
//   Session / Membership / Role（含 coordinator —— 它不参与调用链）
//   + 角色冲突错误分类法（role_conflict / dri_already_set / ...）
//
// P1（2026-09-27）：词汇从空壳补成真类型。实现由 impl/space-store-sqlite 提供。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    session: SessionService
  }
}

// ── 角色词汇 ──────────────────────────────────────────────────────────────
// 取值与库里的 CHECK 约束逐字一致（迁移 0001_svc_session）——
// 改这里必须同时改迁移，反过来也一样；两边都对不齐时门禁与库二选一地撒谎。

/** 参与者在一场会议里的角色。 */
export type Role =
  | '协调者'
  | '会议记录官'
  | '挑战者'
  | '需求分析师'
  | 'DRI'
  | '成员'
  | '群主'
  | '管理员'

export const ROLES: readonly Role[] = [
  '协调者',
  '会议记录官',
  '挑战者',
  '需求分析师',
  'DRI',
  '成员',
  '群主',
  '管理员',
]

/** 三个目标 Agent 角色（@ 提及清单与授权名单的候选集）。 */
export const TARGET_AGENT_ROLES: readonly ['会议记录官', '挑战者', '需求分析师'] = [
  '会议记录官',
  '挑战者',
  '需求分析师',
]

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v)
}

/** 协调者是调度者，**不在**授权名单与 @ 提及清单里（不参与调用链）。 */
export function isCoordinator(r: Role): boolean {
  return r === '协调者'
}

export function isTargetAgentRole(r: Role): boolean {
  return (TARGET_AGENT_ROLES as readonly string[]).includes(r)
}

export function isHumanRole(r: Role): boolean {
  // IM 化（2026-09-30）：人类成员角色扩为 群主/管理员/DRI/成员。
  return r === 'DRI' || r === '成员' || r === '群主' || r === '管理员'
}

/** IM 语义：群主 = 会话创建者，管理员可邀请/移除成员。 */
export function isGroupOwner(r: Role): boolean {
  return r === '群主'
}

export function isGroupAdmin(r: Role): boolean {
  return r === '群主' || r === '管理员'
}

// ── 状态词汇 ──────────────────────────────────────────────────────────────

/** 会议（业务会话）状态。 */
export type SessionStatus = 'open' | 'closed'

/** 成员在册状态：active 在册 / left 已离开。 */
export type MemberStatus = 'active' | 'left'

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一场会议。对应 sessions 表一行。id 形如 "s_<随机>"，由实现层生成。 */
export interface Session {
  id: string
  title: string
  /** 阶段 id 由 kickoff 插件域定义；核心链只存不解释。 */
  currentPhase: string | null
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface SessionInput {
  /** 缺省由实现层生成（"s_" 前缀）。 */
  id?: string
  title: string
}

/** 一条成员关系。对应 session_members 表一行。 */
export interface Membership {
  sessionId: string
  principalId: string
  role: Role
  status: MemberStatus
  /** 成员分工（可兼任）。 */
  duty: string
  joinedAt: string
  /** NULL = 从未离开。 */
  leftAt: string | null
}

export interface JoinInput {
  sessionId: string
  principalId: string
  /** 缺省 '成员'。 */
  role?: Role
  /**
   * Agent 入会时可保存目录 title 作为分工展示名，避免所有 Agent 都显示为「成员」；
   * 缺省空串；重新激活（曾 left）时不传则保留旧值不清洗。
   */
  duty?: string
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type SessionErrorCode =
  /** 已在册且角色与请求不同 —— 改角色是显式操作，不能当"加入"的副作用。 */
  | 'role_conflict'
  /** 该会话已有在册 DRI（单 DRI 由库里的部分唯一索引兜底）。 */
  | 'dri_already_set'
  | 'not_found'
  | 'invalid_role'
  | 'invalid_input'

export class SessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义（承旧 member.go，验收时逐条对拍）：
//   · join 幂等：已在册且角色相同 → 原样返回；角色不同 → role_conflict；
//     曾经 left 过 → 原行激活（不新建，主键是 (session_id, principal_id)）
//   · 一场会议最多一个在册 DRI：违反 → dri_already_set
//   · 时间戳一律 ISO 8601（UTC）
export abstract class SessionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'session')
  }

  /** 建一场会议（open 状态）。 */
  abstract createSession(input: SessionInput): Session

  /** 取一场会议；不存在返回 undefined。 */
  abstract getSession(id: string): Session | undefined

  /** 全部会议，按创建时间升序。 */
  abstract listSessions(): Session[]

  /** 关闭会议。幂等：已关闭原样返回；不存在抛 not_found。 */
  abstract closeSession(id: string): Session

  /** 加入会议（含重新激活）。语义见类注释。 */
  abstract join(input: JoinInput): Membership

  /** Change the role of an active member; does not alter membership timestamps or duty. */
  abstract setRole(sessionId: string, principalId: string, role: Role): Membership

  /** 离开会议。未在册抛 not_found。 */
  abstract leave(sessionId: string, principalId: string): void

  /** 会议成员列表；onlyActive 缺省 true（只看在册）。 */
  abstract listMembers(sessionId: string, onlyActive?: boolean): Membership[]
}
