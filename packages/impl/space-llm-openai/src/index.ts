// space-llm-openai —— space-llm 缝的 OpenAI 兼容实现（P8 下半场，2026-09-30）。
//
// 语义（seam 契约照表执法）：
//   · configured：后台 settings、插件配置或 LLM_BASE_URL / LLM_API_KEY /
//     LLM_MODEL 环境变量中有一套完整配置（每次读取现算）。
//   · chat：单次 POST {base}/chat/completions（Authorization: Bearer <key>，
//     body = {model, messages}），返回 choices[0].message.content 原文。
//     **不自动重试**（承「不猜」）；超时缺省 60s（AbortSignal.timeout）；
//     失败抛 LlmError（http_error / timeout / not_configured / empty_response），
//     消息里**绝不含 key**。
//
// 依赖方向（lint:deps 断言①）：impl 只准依赖 seams —— 本包只依赖 space-llm。
import type { Context } from 'cordis'
import z from 'schemastery'
import { LlmError, LlmService } from 'space-llm'
import type { ChatMessage, ChatOptions } from 'space-llm'
import { LLM_API_KEY_ENV, LLM_BASE_URL_ENV, LLM_MODEL_ENV } from 'space-llm'
import { SettingsService } from 'space-settings'

/** 单次调用超时缺省值（60s，拍板口径）。 */
export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 配置面板 schema（5172 plugin-loader-webui 自动渲染）：
 * 配置值优先、env 兜底 —— 面板里留空即回退 .env 的 LLM_* 三件套。
 */
export const Config = z.intersect([
  z.object({
    apiKey: z.string().role('secret').description('API Key（留空则回退 env LLM_API_KEY）').default(''),
    baseURL: z.string().description('OpenAI 兼容 Base URL（留空回退 LLM_BASE_URL）').default(''),
    model: z.string().description('模型名（留空回退 LLM_MODEL）').default(''),
    timeoutMs: z.number().description('单次调用超时 ms').default(60000),
  }),
])

/** 运行时取值形状（面板/cordis 传来的 config 可能缺字段，全部按可选处理）。 */
export interface ConfigInput {
  apiKey?: string
  baseURL?: string
  model?: string
  timeoutMs?: number
}

export class OpenAiChatLlm extends LlmService {
  private readonly cfg: ConfigInput
  private readonly settings: SettingsService | null

  constructor(ctx: Context, config: ConfigInput = {}, settings?: SettingsService | null) {
    super(ctx)
    this.cfg = config
    // 设置缝可选注入（2026-10-05）：5172「模型与接入」页写入的 llm.* 键
    // 优先于本地 Config 与 env —— 面板改完即生效，无需重启。
    this.settings = settings ?? null
  }

  /** 取值优先级：settings（面板设置页）> Config > env 兜底（每次现算）。 */
  private resolve(): { key: string; base: string; model: string } {
    const s = this.settings
    return {
      key:
        (s && s.get<string>('llm.apiKey', '').trim()) ||
        this.cfg.apiKey?.trim() ||
        process.env[LLM_API_KEY_ENV]?.trim() ||
        '',
      base:
        (s && s.get<string>('llm.baseURL', '').trim()) ||
        this.cfg.baseURL?.trim() ||
        process.env[LLM_BASE_URL_ENV]?.trim() ||
        '',
      model:
        (s && s.get<string>('llm.model', '').trim()) ||
        this.cfg.model?.trim() ||
        process.env[LLM_MODEL_ENV]?.trim() ||
        '',
    }
  }

  get configured(): boolean {
    const { key, base, model } = this.resolve()
    return Boolean(key && base && model)
  }

  async chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string> {
    const { base, key, model: configuredModel } = this.resolve()
    const model = options?.model?.trim() || configuredModel
    if (!base || !key || !model) {
      throw new LlmError(
        'not_configured',
        `LLM 未配置：需要面板配置（apiKey/baseURL/model）或 ${LLM_BASE_URL_ENV} / ${LLM_API_KEY_ENV} / ${LLM_MODEL_ENV} 三件套（key 不落日志）`,
      )
    }
    const url = `${base.replace(/\/+$/, '')}/chat/completions`
    // 超时优先级：调用方 options > 面板配置 > 缺省 60s。
    const timeoutMs = options?.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, ...(options?.onToken ? { stream: true } : {}) }),
        signal: options?.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
          : AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const err = e as Error
      if (options?.signal?.aborted) {
        throw new LlmError('cancelled', 'LLM 调用因 Agent 任务已撤回而取消')
      }
      if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message)) {
        throw new LlmError('timeout', `LLM 调用超时（${timeoutMs}ms，单次不重试）`)
      }
      throw new LlmError('http_error', `LLM 请求失败：${err.message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new LlmError('http_error', `LLM 返回 ${res.status}（单次不重试）：${text.slice(0, 200)}`)
    }
    if (options?.onToken && res.headers.get('content-type')?.includes('text/event-stream')) {
      if (!res.body) throw new LlmError('empty_response', 'LLM 流式响应没有 body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let content = ''
      const consume = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') return
        let parsed: { choices?: Array<{ delta?: { content?: unknown } }> }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
          throw new LlmError('http_error', 'LLM 流式响应包含无效事件')
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta !== 'string' || !delta) return
        content += delta
        try { options.onToken?.(delta) } catch { /* UI progress is best effort. */ }
      }
      try {
        while (true) {
          const { value, done } = await reader.read()
          pending += decoder.decode(value, { stream: !done })
          const lines = pending.split(/\r?\n/u)
          pending = lines.pop() ?? ''
          for (const line of lines) consume(line)
          if (done) break
        }
        if (pending.trim()) consume(pending)
      } catch (error) {
        if (error instanceof LlmError) throw error
        if (options.signal?.aborted) throw new LlmError('cancelled', 'LLM 调用因 Agent 任务已撤回而取消')
        const err = error as Error
        if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message)) {
          throw new LlmError('timeout', `LLM 流式调用超时（${timeoutMs}ms，单次不重试）`)
        }
        throw new LlmError('http_error', `LLM 流式读取失败：${err.message}`)
      } finally {
        reader.releaseLock()
      }
      if (!content) throw new LlmError('empty_response', 'LLM 流式响应没有文本内容')
      return content
    }
    let payload: { choices?: { message?: { content?: unknown } }[] }
    try {
      payload = (await res.json()) as typeof payload
    } catch (e) {
      throw new LlmError('http_error', `LLM 响应不是 JSON：${(e as Error).message}`)
    }
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new LlmError('empty_response', 'LLM 响应缺 choices[0].message.content')
    }
    if (content && options?.onToken) {
      try { options.onToken(content) } catch { /* UI progress is best effort. */ }
    }
    return content
  }
}

export const name = 'space-llm-openai'
// settings（2026-10-05）：5172 设置页写入的 llm.* 键优先于 Config/env。
export const inject: string[] = ['settings']

export function apply(ctx: Context, config: ConfigInput = {}) {
  // Service 基类构造即 provide（承 agent-registry / workdir 同款）。
  new OpenAiChatLlm(ctx, config, ctx.settings)
}
