// seam/space-tool —— 工具层能力缝（2026-09-30 分层架构补真）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 plugins/space-tool 提供（ctx.tools）：工具注册表 + 受控调用 + 留痕。
// 上层（Agent 层 / 流转层）只许通过本缝用工具，不得绕过注册表直连能力 ——
// 这是「高内聚低耦合」的工具面：能力方注册，使用方按名调用，闸门在一处。
//
// 词汇（承旧 elements/tool/ + internal/tools/）：
//   工具目录 + 注册表（重名即编程错误，注册期就炸 —— 承断言 ⑥）
//   调用必须带调用者身份（invoker），结果可审计（每笔调用可带 audit 详情）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    tools: ToolService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个工具的注册描述符。handler 由能力方提供，注册表不解释其内容。 */
export interface ToolDescriptor {
  /** 幂等键（注册表主键），形如 'tool.<名字>'。 */
  id: string
  /** 给人看的名字。 */
  title: string
  /** Agent 端工具目录中显示的用途与 JSON 参数说明。 */
  description?: string
  /** Optional JSON Schema for provider-native function calling. */
  parameters?: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  /** 能力域开放词表：'workdir' / 'llm' / 'search' / 'notify' …。 */
  capabilities: readonly string[]
  /**
   * 工具执行体：(args, invoker) → 结果文本。实现方自行保证幂等与超时；
   * 抛错按 ToolError 传递（实现层不得吞错）。
   */
  handler: (args: string, invoker: ToolInvoker) => Promise<string> | string
}

/** 调用者身份（审计与闸门的主体）。 */
export interface ToolInvoker {
  /** 调用者 principal id（u_* / a_*）。 */
  id: string
  /** 调用发生的会话（全局工具可空）。 */
  sessionId?: string
  /** Abort long-running work when the owning Agent run is invalidated. */
  signal?: AbortSignal
}

/** 一次工具调用的结果。 */
export interface ToolResult {
  toolId: string
  ok: boolean
  /** 成功 = 输出文本；失败 = 人类可读错误（错误码在 code）。 */
  output: string
  code?: string
  /** 耗时毫秒（可观测）。 */
  costMs: number
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type ToolErrorCode =
  | 'duplicate_tool'
  | 'unknown_tool'
  | 'not_allowed'
  | 'handler_error'

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · register：重名 → duplicate_tool（注册期炸，承断言 ⑥）。
//   · invoke：未知工具 → unknown_tool；实现层的 allowlist 判 not_allowed；
//     handler 抛错包成 handler_error，结果里必须带 code（可观测，铁律 2）。
//   · list：按 id 稳定排序。
export abstract class ToolService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** 注册一个工具（重名即炸）。 */
  abstract register(desc: ToolDescriptor): void

  /** 受控调用：allowlist 校验 → handler → 结果（含耗时）。 */
  abstract invoke(toolId: string, args: string, invoker: ToolInvoker): Promise<ToolResult>

  /** 工具目录（给人看 / 给 Agent 的上下文注入层用）。 */
  abstract list(): ToolDescriptor[]
}
