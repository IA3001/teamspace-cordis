// seam/space-llm —— 能力缝（P8 下半场，2026-09-30）。
//
// 这一层**只有词汇**：Service 声明 + 消息形状 + 错误分类法 + 环境变量名。
// 零实现、零 IO。实现放 packages/impl/space-llm-openai/（OpenAI 兼容口）。
//
// 为什么独立成缝：大脑（brain-llm）与 coding 干活路径（agent-runtime）是
// 两类消费者；将来换模型厂商 / 加流式，只换 impl，消费方零改动（规律 1）。
//
// 「不猜」口径（承引擎）：chat 是**单次**调用 —— 不自动重试；失败抛结构化
// LlmError，由调用方决定走向（大脑 → coordinator_error 暂停；干活 → 状态回
// idle 后上抛）。超时缺省 60s。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}

// ── 配置词汇：.env 三件套（key 绝不入库不入日志）──────────────────────────
// 用户自行往 .env 填（OpenAI 兼容口）；实现的 configured 以三件套齐为准。

export const LLM_API_KEY_ENV = 'LLM_API_KEY'
export const LLM_BASE_URL_ENV = 'LLM_BASE_URL'
export const LLM_MODEL_ENV = 'LLM_MODEL'

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一条补全消息（OpenAI chat 词汇的子集，够用即止）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  /** Undefined means the provider did not report cache usage; it is not zero. */
  cachedInputTokens?: number
  firstTokenMs?: number
  durationMs: number
}

export interface ChatOptions {
  /** 单次调用超时（毫秒）。缺省 60_000。 */
  timeoutMs?: number
  /** Per-call output ceiling; provider-profile limits can impose a lower hard cap. */
  maxTokens?: number
  /** Named administrator-managed provider profile; missing profiles fail closed. */
  profileRef?: string
  /** Per-call model override within the selected provider. */
  model?: string
  /** Cancel a request when its causal Agent run is withdrawn. */
  signal?: AbortSignal
  /** Optional user-facing completion deltas; callers must not persist them as Agent context. */
  onToken?: (delta: string) => void
  /** Numerical provider statistics only; no prompt content or credentials. */
  onUsage?: (usage: ChatUsage) => void
}

// ── 错误分类法（规律 3：实现不得自造错误串，只能抛这里的错误码）────────────

export type LlmErrorCode =
  /** .env 三件套缺一（key/base/model）。 */
  | 'not_configured'
  /** 非 2xx / 响应不是 JSON / 网络错误（带原因，不含 key）。 */
  | 'http_error'
  /** 单次调用超时（缺省 60s），不重试。 */
  | 'timeout'
  /** Caller cancelled this request because its source work was invalidated. */
  | 'cancelled'
  /** 响应缺 choices[0].message.content（形状不符）。 */
  | 'empty_response'

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · configured：三件套齐且 key 非空（每次读取现算 —— 测试可在进程内翻转）。
//   · chat：单次 POST {base}/chat/completions（Bearer key），返回
//     choices[0].message.content 原文（可为空串）；不重试；超时/失败抛 LlmError。
export abstract class LlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract get configured(): boolean

  /** Whether a specific named provider profile can serve a request. */
  configuredFor(profileRef?: string): boolean {
    return !profileRef && this.configured
  }

  abstract chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string>
}
