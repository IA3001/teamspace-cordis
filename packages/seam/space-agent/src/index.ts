// seam/space-agent —— 能力缝（P6 新增，2026-09-29）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/ 或 plugins/（注册表提供者）；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（断言 ①②）。
//
// 词汇（2026-09-29 新需求，MODULE-PLAN §3.2 / 第 7 节决策 8）：
//   AgentKind = 'meeting' | 'coding'        —— 会议机器人与 Coding Agent 同一张表
//   AgentDescriptor{id, kind, title, promptRef?, capabilities}
//   AgentStatus 生命周期状态机 idle / working / paused / done + STATUS_TRANSITIONS
//   入驻 / 退驻 / 心跳
//
// 铁律 4（.rules/IRON-RULES.md）：**入驻 = 向本缝注册**，纯新增（新增包 + patch 层一行），
// 不许往核心或会议链路加特判。「自己的天地」= cordis isolate realm（5172/5174 先例）；
// 「自己的生命」= 插件生命周期 + 每 agent runtime；「自己的工作区」= space-workdir 缝。
// 入驻的 agent 进会话时以本 id 成为 Member（与 space-session 缝对齐）；
// agent 永远不当协调者（协调者不参与调用链，承 space-session 口径）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    agents: AgentService
  }
}

// ── 类别词汇 ──────────────────────────────────────────────────────────────

/** Built-ins may declare a meeting/coding role; Team-created Agents use the generic kind. */
export type AgentKind = 'meeting' | 'coding' | 'custom'

export const AGENT_KINDS: readonly AgentKind[] = ['meeting', 'coding', 'custom']

export function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(v)
}

// ── 生命周期状态机（词汇层拥有迁移语义，实现只照表执法）──────────────────

/** agent 生命周期状态：idle 待命 / working 干活 / paused 暂停（等人） / done 交付。 */
export type AgentStatus = 'idle' | 'working' | 'paused' | 'done'

export const AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'working', 'paused', 'done']

/**
 * 状态迁移表（合法迁移白名单，表外一律 invalid_transition）：
 *   idle    → working（领任务）/ paused（人类提前叫停）
 *   working → paused（暂停点 await_human）/ done（交付）/ idle（来源撤回取消）
 *   paused  → working（人类放行）/ idle（任务作废回待命）
 *   done    → idle（可领下一个任务）
 */
export const STATUS_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ['working', 'paused'],
  working: ['paused', 'done', 'idle'],
  paused: ['working', 'idle'],
  done: ['idle'],
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to)
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个机器人的入驻描述符。 */
export interface AgentDescriptor {
  /** 幂等键（注册表主键），形如 'agent.<名字>'；入会时即 Member 标识。 */
  id: string
  kind: AgentKind
  /** 给人看的名字（@ 提及候选，如「编码者」）。 */
  title: string
  /** 提示词引用（待定 10：接入形态等用户给原文；缺省 = 无提示词，stub 行为）。 */
  promptRef?: string
  /** Shared-template metadata; consumers may use supported fields generically. */
  description?: string
  /** Named administrator-managed model provider profile; empty uses system default. */
  llmProfileRef?: string
  toolIds?: readonly string[]
  contextSources?: readonly string[]
  memoryPolicy?: string
  speechPolicy?: string
  /** 能力清单（开放词表：'minutes' / 'coding' / 'testing' / 'review' …）。 */
  capabilities: readonly string[]
}

/** 注册表里的一个 agent 快照（描述符 + 生命周期现场）。 */
export interface AgentSnapshot {
  descriptor: AgentDescriptor
  status: AgentStatus
  /** 进入当前状态的时刻（Date.now()）。 */
  since: number
  /** 最近一次心跳时刻；未跳过为 null。 */
  lastHeartbeatAt: number | null
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type AgentErrorCode =
  /** id 重复 —— 重名是编程错误，注册期就炸（承 duplicate_panel 口径）。 */
  | 'duplicate_agent'
  | 'not_found'
  /** kind 不在两类词汇里。 */
  | 'invalid_kind'
  /** 状态迁移不在 STATUS_TRANSITIONS 白名单里。 */
  | 'invalid_transition'

export class AgentError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · register：id 重复 → duplicate_agent 即炸；kind 非法 → invalid_kind；
//     初始状态恒为 idle（报到即待命）
//   · unregister：not_found；退驻后 id 可被重新入驻（重开）
//   · heartbeat / setStatus / get：未知 id → not_found；setStatus 迁移非法 → invalid_transition
//   · list(kind?)：按 id 稳定排序
export abstract class AgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /** 入驻：登记描述符，初始 idle。id 重复即炸。 */
  abstract register(desc: AgentDescriptor): void

  /** 退驻：移出注册表。 */
  abstract unregister(id: string): void

  /** 心跳：刷新 lastHeartbeatAt（供可见性/探活，不改状态）。 */
  abstract heartbeat(id: string): void

  /** 状态迁移：照 STATUS_TRANSITIONS 白名单执法。 */
  abstract setStatus(id: string, status: AgentStatus): void

  abstract get(id: string): AgentSnapshot

  abstract list(kind?: AgentKind): AgentSnapshot[]

  /** Reconcile data-backed Agent definitions into the process-local runtime registry. */
  abstract refreshCatalog(): void
}
