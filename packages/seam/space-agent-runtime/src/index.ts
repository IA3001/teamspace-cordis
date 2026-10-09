// seam/space-agent-runtime —— 能力缝（P8，2026-09-30）。
//
// 这一层**只有词汇**：Service 声明 + 回执类型。零实现、零 IO。
// 实现放 packages/impl/space-agent-runtime/（P8 机制插件）；只能依赖本包。
//
// 为什么独立成缝（防杂物袋判据，待定 8 先例）：
//   · space-agent 管「名单与生命周期」（谁入驻、什么状态）—— 零干活语义；
//   · 干活路径（领工作区 → 任务落盘 → 状态机走满 → 回执）是**执行域**，变更
//     节奏与名单管理不同。P6 时它暂住 agent-coder-stub（当时头注记账：第二个
//     agent 入驻时升格）；P8 第二、三个 coding agent（测试者/审查者）入驻，
//     按记账升格为机制 —— coding 类 agent 只带「描述符 + 委托认领」两个纯新增件。
//   · 错误分类法**不另立**：本缝的错误全部由既有缝承载 —— space-agent
//     （not_found / invalid_transition=正忙）、space-workdir（not_found /
//     already_assigned / path_escape / cleanup_failed）、space-prompt（not_found，
//     实现层降级不炸）。规律 3：实现不得自造错误串。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    agentRuntime: AgentRuntimeService
  }
  interface Events {
    /** Ephemeral, human-facing execution updates; never persisted to the session timeline. */
    'space/agent-progress'(this: Context, update: AgentProgressUpdate): void
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

export type AgentProgressPhase =
  | 'started' | 'preparing' | 'processing' | 'tool-start' | 'tool-finish'
  | 'text-delta' | 'finalizing' | 'completed' | 'failed' | 'cancelled'

export interface AgentProgressUpdate {
  runId: string
  sessionId: string
  agentId: string
  title: string
  sourceEventId: string | null
  phase: AgentProgressPhase
  toolId?: string
  ok?: boolean
  /** Final answer text for human UI streaming only; never persisted or sent to other Agents. */
  delta?: string
  at: string
}

/** 一次干活路径的回执。receipt 是给人看的时间线文本；其余字段给断言与未来 UI。 */
export interface CodingReceipt {
  /** 干活的 agent（= 入参 agentId）。 */
  agentId: string
  /** 名册 title（回执文案与日志用）。 */
  title: string
  /** 收到的任务原文。 */
  task: string
  /** 工作区绝对路径（ctx.workdir.claim 的 root）。 */
  root: string
  /** 产物文件名清单（工作区根下的相对路径）。 */
  files: string[]
  /** 时间线回执全文（含【工作区】【产物清单】，有提示词时含【提示词】）。 */
  receipt: string
  /** 本次实际取到的提示词 ref；未绑定 / 服务缺席 / 未预置 → null（降级不炸）。 */
  promptRef: string | null
  /** 提示词标题（promptRef 非 null 时有值）。 */
  promptTitle: string | null
  /**
   * 交付模式（P8 下半场，诚实标注的机器口径）：'llm' = 真模型生成（ctx.llm
   * 在且 .env 三件套齐）；'stub' = 写文件级占位。回执文本与产物文件标注必须
   * 与本字段一致 —— 绝不冒充（铁律 2：看见的是真实状态）。
   */
  mode: 'llm' | 'stub'
  /** 真模型模式下的模型名（.env LLM_MODEL）；stub 模式 null。 */
  model: string | null
  /** Tools that actually ran during this task, including failures. */
  toolResults?: Array<{ toolId: string; ok: boolean; output: string; code?: string; costMs: number }>
  /** Session events and memories that informed this result. */
  sourceEventIds?: string[]
}

export interface AgentRunContext {
  sessionId?: string
  /** Causal source that can invalidate and cancel this run. */
  sourceEventId?: string
}

export class AgentRunCancelledError extends Error {
  constructor(sourceEventId: string) {
    super(`Agent run cancelled because source event ${sourceEventId} was withdrawn`)
    this.name = 'AgentRunCancelledError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义（承 agent-coder-stub perform 的既有行为，P8 原样升格）：
//   · perform：未知 agentId → AgentError not_found（名册制）；
//     正忙（idle→working 被状态机拒绝）→ AgentError invalid_transition，
//     文案含「正忙」（/tell 的 A11 断言依赖）；干活中途失败 → 状态回 idle 后
//     原样上抛；成功 → working→done→idle 走满一圈，任务文件经 workdir.resolve
//     落盘（execdir 铁则），回执含【工作区】与【产物清单】。
export abstract class AgentRuntimeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentRuntime')
  }

  /** 走完一条干活路径并返回回执。调用方决定回执去向（/tell 直接回复；委托链走收执口）。 */
  abstract perform(agentId: string, task: string, context?: AgentRunContext): Promise<CodingReceipt>

  /** Abort active runs whose delegation source is being withdrawn. */
  abstract cancelBySource(sourceEventId: string): Promise<number>

  /** Wait for runs already registered under this cause without cancelling them. */
  abstract waitForSource(sourceEventId: string): Promise<void>

  /** Register any plugin-backed Agent work under its causal source for coordinated cancellation. */
  abstract registerSourceRun(sourceEventId: string, cancel: () => void, settled: Promise<unknown>): () => void
}
