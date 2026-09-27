// seam/space-event —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法 + 纯校验函数。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 domain/event.go）：
//   事件模型（append-only）、会话内序号、事件类型注册表、纯校验函数
//
// ⚠️ 服务名是 ctx.eventLog，**不是** ctx.events —— cordis 内核已占用 `events`
// （内核的 events 是事件总线，本缝是会话内 append-only 的事件存储，两回事）。
// 2026-09-27 P0 实测撞名（TS2717）后改名，见 MODULE-PLAN 修订记录。
//
// P1（2026-09-27）：词汇从空壳补成真类型。实现由 impl/space-store-sqlite 提供。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    eventLog: EventLogService
  }
}

// ── 事件种类（值域与库里的 CHECK 一致：迁移 0002_svc_events）──────────────

/** 事件种类。 */
export type EventKind = 'message' | 'decision' | 'approval' | 'system'

export const EVENT_KINDS: readonly EventKind[] = [
  'message',
  'decision',
  'approval',
  'system',
]

export function isEventKind(v: string): v is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(v)
}

/** 事件作者的种类。比 EventKind 多一个 system —— 事件可以来自系统，参与者不能。 */
export type AuthorKind = 'human' | 'agent' | 'system'

export const AUTHOR_KINDS: readonly AuthorKind[] = ['human', 'agent', 'system']

export function isAuthorKind(v: string): v is AuthorKind {
  return (AUTHOR_KINDS as readonly string[]).includes(v)
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一次工具调用的记录（进事件的 toolCalls）。 */
export interface ToolCall {
  name: string
  args: string
  result?: string
  err?: string
}

/**
 * 一条事件。对应 events 表一行。
 *
 * **铁律：事件只追加、永不改。** 废止走 voided 标记（by/at/reason 三项留痕
 * 缺一不可），绝不 DELETE —— 历史不能被事后美化。
 *
 * seq 是顺序的依据：同一会话内单调递增，由实现层在追加时分配。
 * 不用时间戳排序：同一毫秒内会有多条，"谁先谁后"是事实，不能赌时间戳精度。
 */
export interface SessionEvent {
  /** 幂等键。 */
  id: string
  sessionId: string
  seq: number
  /** 阶段 id 由 kickoff 插件域定义；核心链只存不解释。 */
  phaseId: string | null
  ts: string
  /** NULL = 系统事件（不是任何参与者说的）。 */
  authorId: string | null
  authorKind: AuthorKind
  kind: EventKind
  text: string
  /** 显式实体 id（principal_id），不做文本解析。 */
  mentions: string[]
  toolCalls: ToolCall[]
  /** 长回复 / 快速回复。 */
  replyMode: string
  voided: boolean
  /** 废止留痕三项：谁撤的 / 何时 / 为什么。 */
  voidedBy: string | null
  voidedAt: string | null
  voidedReason: string | null
}

/**
 * append 的入参：调用方填身份与内容；缺省 ts 由实现层补，seq 由实现层分配。
 * 显式给 seq 仅用于恢复/导入场景：必须 ≥ 该会话下一个可用序号，否则拒绝（顺序不能回退）。
 */
export type EventInput = Omit<
  SessionEvent,
  'seq' | 'ts' | 'voided' | 'voidedBy' | 'voidedAt' | 'voidedReason'
> & { ts?: string; seq?: number }

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type EventLogErrorCode =
  /** 同 ID 重复追加（ID 是幂等键，重放同一条必须报错而不是静默忽略）。 */
  | 'duplicate_id'
  /** 显式指定的 seq 会回退顺序。 */
  | 'seq_regressed'
  /** 事件自身不合法（用 validateEvent 的结论）。 */
  | 'invalid'
  /** 废止/查询目标不存在，或已废止过。 */
  | 'not_found'

export class EventLogError extends Error {
  constructor(
    public readonly code: EventLogErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EventLogError'
  }
}

// ── 纯校验函数（承旧 Event.Validate，实现层与未来的内存实现共用）────────────
// seq 在这里**不校验**：它由实现层分配，不是调用方填的。
// 校验调用方填不了的东西只会产生"永远通过"的假断言。

export function validateEvent(e: EventInput): void {
  if (!e.id || !e.id.trim()) {
    throw new EventLogError('invalid', '事件缺少 id（id 是幂等键，不能为空）')
  }
  if (!e.sessionId || !e.sessionId.trim()) {
    throw new EventLogError('invalid', `事件 ${e.id} 缺少 sessionId`)
  }
  if (!isAuthorKind(e.authorKind)) {
    throw new EventLogError(
      'invalid',
      `事件 ${e.id} 的 authorKind=${JSON.stringify(e.authorKind)} 非法（只允许 human/agent/system）`,
    )
  }
  if (!isEventKind(e.kind)) {
    throw new EventLogError('invalid', `事件 ${e.id} 的 kind=${JSON.stringify(e.kind)} 非法`)
  }
  // 系统事件没有作者；人和 Agent 必须有。这条不对称必须校验：
  // 否则会出现"作者是空的发言"，视图渲染时既不是人也不是系统，只能静默丢弃。
  if (e.authorKind === 'system' && e.authorId) {
    throw new EventLogError(
      'invalid',
      `系统事件 ${e.id} 不该有 authorId（实际 ${JSON.stringify(e.authorId)}）`,
    )
  }
  if (e.authorKind !== 'system' && (!e.authorId || !e.authorId.trim())) {
    throw new EventLogError(
      'invalid',
      `事件 ${e.id} 的 authorKind=${e.authorKind} 却缺少 authorId`,
    )
  }
  // 发言必须有内容。空 message 会污染视图与上下文预算。
  if (e.kind === 'message' && !e.text.trim()) {
    throw new EventLogError('invalid', `发言事件 ${e.id} 的 text 为空`)
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义（承旧 event.go 的 Log，验收时逐条对拍）：
//   · append 分配 seq 并落库；同 ID 重复追加 → duplicate_id（不是静默忽略）
//   · 显式 input.seq 必须 ≥ 该会话下一个可用序号，否则 → seq_regressed
//   · void 打标记不删除；by/reason 为空 → invalid（废止必须留痕）
//   · 时间戳一律 ISO 8601（UTC）
export abstract class EventLogService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'eventLog')
  }

  /** 追加一条事件，分配 seq，返回落定后的完整事件。 */
  abstract append(input: EventInput): SessionEvent

  /** 废止一条事件（打标记，不删除）。返回受影响条数：0 = 没这条或已废止过。 */
  abstract void(id: string, by: string, reason: string): number

  /** 某会话全部事件，按 seq 升序（含已废止的 —— 顺序是事实，脱敏是视图层的事）。 */
  abstract listBySession(sessionId: string): SessionEvent[]

  /** 某会话当前最大序号（0 = 还没有事件）。 */
  abstract lastSeq(sessionId: string): number

  /**
   * 会话内全文检索。实现层用 FTS5 trigram；查询词不足 3 字符时
   * 允许走 LIKE 兜底（trigram 对 2 字词命中率的问题，承旧链实测结论）。
   */
  abstract search(sessionId: string, query: string): SessionEvent[]
}
