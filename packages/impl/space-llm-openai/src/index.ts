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
import type { ChatMessage, ChatOptions, ChatUsage } from 'space-llm'
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
    streamUsage: z.boolean().description('请求流式 Token 与缓存用量；不兼容供应商可关闭').default(true),
  }),
])

/** 运行时取值形状（面板/cordis 传来的 config 可能缺字段，全部按可选处理）。 */
export interface ConfigInput {
  /** Disable only for a provider that rejects OpenAI stream usage requests. */
  streamUsage?: boolean
  apiKey?: string
  baseURL?: string
  model?: string
  timeoutMs?: number
}

const positiveTokenLimit = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 200_000 ? value : undefined

function networkFailure(error: Error): string {
  const cause = error.cause && typeof error.cause === 'object'
    ? error.cause as { code?: unknown; message?: unknown }
    : undefined
  const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{2,48}$/u.test(cause.code) ? cause.code : undefined
  const reasons: Record<string, string> = {
    EAI_AGAIN: 'DNS 临时解析失败',
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被对端重置',
    ENOTFOUND: '域名无法解析',
    ETIMEDOUT: '连接超时',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  }
  if (code && reasons[code]) return `LLM 网络连接失败（${code}：${reasons[code]}）`
  const detail = typeof cause?.message === 'string' ? cause.message
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[已隐藏]')
    : ''
  return `LLM 请求失败：${error.message}${detail && detail !== error.message ? `（底层原因：${detail.slice(0, 180)}）` : '（未收到 HTTP 响应）'}`
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
  private resolve(profileRef?: string): { key: string; base: string; model: string; maxOutputTokens?: number } {
    const s = this.settings
    const selectedRef = profileRef || s?.get<string>('llm.activeProfileRef', '').trim()
    if (selectedRef) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(selectedRef)) {
        throw new LlmError('not_configured', '文字模型配置引用格式无效')
      }
      const profiles = s?.get<Array<{ id?: string }>>('llm.profiles', []) ?? []
      if (!profiles.some((profile) => profile.id === selectedRef)) {
        throw new LlmError('not_configured', `文字模型配置「${selectedRef}」不存在`)
      }
      return {
        key: s?.get<string>(`llm.profile.${selectedRef}.apiKey`, '').trim() ?? '',
        base: s?.get<string>(`llm.profile.${selectedRef}.baseURL`, '').trim() ?? '',
        model: s?.get<string>(`llm.profile.${selectedRef}.model`, '').trim() ?? '',
        maxOutputTokens: positiveTokenLimit(s?.get<number>(`llm.profile.${selectedRef}.maxOutputTokens`, 0)),
      }
    }
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
      maxOutputTokens: positiveTokenLimit(s?.get<number>('llm.maxOutputTokens', 0)),
    }
  }

  get configured(): boolean {
    return this.configuredFor()
  }

  override configuredFor(profileRef?: string): boolean {
    try {
      const { key, base, model } = this.resolve(profileRef)
      return Boolean(key && base && model)
    } catch {
      return false
    }
  }

  async chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string> {
    const { base, key, model: configuredModel, maxOutputTokens: profileLimit } = this.resolve(options?.profileRef)
    const model = options?.model?.trim() || configuredModel
    if (!base || !key || !model) {
      throw new LlmError(
        'not_configured',
        `LLM 未配置：需要面板配置（apiKey/baseURL/model）或 ${LLM_BASE_URL_ENV} / ${LLM_API_KEY_ENV} / ${LLM_MODEL_ENV} 三件套（key 不落日志）`,
      )
    }
    const started = Date.now()
    let firstTokenMs: number | undefined
    let providerUsage: Record<string, unknown> | undefined
    const recordUsage = (value: unknown) => {
      if (value && typeof value === 'object') providerUsage = value as Record<string, unknown>
    }
    const finishUsage = () => {
      const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      const details = providerUsage?.prompt_tokens_details as Record<string, unknown> | undefined
      const usage: ChatUsage = { inputTokens: number(providerUsage?.prompt_tokens), outputTokens: number(providerUsage?.completion_tokens),
        cachedInputTokens: number(details?.cached_tokens ?? providerUsage?.prompt_cache_hit_tokens), firstTokenMs, durationMs: Date.now() - started }
      try { options?.onUsage?.(usage) } catch { /* Telemetry must not fail successful model work. */ }
    }
    const url = `${base.replace(/\/+$/, '')}/chat/completions`
    // 超时优先级：调用方 options > 面板配置 > 缺省 60s。
    const timeoutMs = options?.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const requestedLimit = positiveTokenLimit(options?.maxTokens)
    const maxTokens = profileLimit && requestedLimit
      ? Math.min(profileLimit, requestedLimit)
      : profileLimit ?? requestedLimit
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          ...(options?.tools?.length ? {
            tools: options.tools.map(({ toolId: _toolId, ...tool }) => tool),
            tool_choice: 'auto',
          } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(options?.onToken ? { stream: true, ...(this.cfg.streamUsage !== false ? { stream_options: { include_usage: true } } : {}) } : {}),
        }),
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
      throw new LlmError('http_error', networkFailure(err))
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 400 && /supported API model names|unsupported.*model|model.*not found|invalid.*model/i.test(text)) {
        throw new LlmError('http_error', `模型「${model}」不被当前供应商接受。请检查 Agent 的“供应商内模型 ID 覆盖”；清空覆盖可使用供应商配置的默认模型。供应商信息：${text.slice(0, 160)}`)
      }
      throw new LlmError('http_error', `LLM 返回 ${res.status}（单次不重试）：${text.slice(0, 200)}`)
    }
    if (options?.onToken && res.headers.get('content-type')?.includes('text/event-stream')) {
      if (!res.body) throw new LlmError('empty_response', 'LLM 流式响应没有 body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let content = ''
      const streamedToolCalls: NativeToolCall[] = []
      const consume = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') return
        let parsed: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: unknown }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
          throw new LlmError('http_error', 'LLM 流式响应包含无效事件')
        }
        recordUsage(parsed.usage)
        const choice = parsed.choices?.[0]
        for (const toolDelta of choice?.delta?.tool_calls ?? []) {
          const index = Number.isSafeInteger(toolDelta.index) && (toolDelta.index ?? -1) >= 0 ? toolDelta.index! : streamedToolCalls.length
          const current = streamedToolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
          current.function ??= { name: '', arguments: '' }
          if (typeof toolDelta.id === 'string') current.id += toolDelta.id
          if (typeof toolDelta.function?.name === 'string') current.function.name += toolDelta.function.name
          if (typeof toolDelta.function?.arguments === 'string') current.function.arguments += toolDelta.function.arguments
        }
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta) {
          firstTokenMs ??= Date.now() - started
          content += delta
          try { options.onToken?.(delta) } catch { /* UI progress is best effort. */ }
        }
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
      if (!content && !streamedToolCalls.length) throw new LlmError('empty_response', 'LLM 流式响应没有文本或工具调用')
      finishUsage()
      return streamedToolCalls.length ? nativeToolCallsEnvelope(streamedToolCalls, options?.tools) : content
    }
    let payload: { choices?: { message?: { content?: unknown; tool_calls?: NativeToolCall[] } }[]; usage?: unknown }
    try {
      payload = (await res.json()) as typeof payload
    } catch (e) {
      const err = e as Error
      if (options?.signal?.aborted) {
        throw new LlmError('cancelled', 'LLM 调用因 Agent 任务已撤回而取消')
      }
      if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message)) {
        throw new LlmError('timeout', `LLM 响应读取超时（${timeoutMs}ms，单次不重试）`)
      }
      throw new LlmError('http_error', `LLM 响应不是有效 JSON：${err.message}`)
    }
    const message = payload?.choices?.[0]?.message
    const content = message?.content
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (typeof content !== 'string' && !toolCalls.length) {
      throw new LlmError('empty_response', 'LLM 响应缺 choices[0].message.content')
    }
    recordUsage(payload.usage)
    if (content) firstTokenMs = Date.now() - started
    if (typeof content === 'string' && content && options?.onToken) {
      try { options.onToken(content) } catch { /* UI progress is best effort. */ }
    }
    finishUsage()
    return toolCalls.length ? nativeToolCallsEnvelope(toolCalls, options?.tools) : content as string
  }
}

interface NativeToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** Keep the provider wire protocol out of business layers; runtime gets the same
 * private envelope it already routes through its allowlisted Tool executor. */
function nativeToolCallsEnvelope(calls: readonly NativeToolCall[], definitions: ChatOptions['tools']): string {
  return JSON.stringify({ toolCalls: calls.map((call) => {
    const name = call.function?.name
    const rawArgs = call.function?.arguments ?? '{}'
    const toolId = definitions?.find((definition) => definition.function.name === name)?.toolId ?? name
    let args: unknown
    try { args = JSON.parse(rawArgs) } catch { args = rawArgs }
    return { toolId, args }
  }) })
}

export const name = 'space-llm-openai'
// settings（2026-10-05）：5172 设置页写入的 llm.* 键优先于 Config/env。
export const inject: string[] = ['settings']

export function apply(ctx: Context, config: ConfigInput = {}) {
  // Service 基类构造即 provide（承 agent-registry / workdir 同款）。
  new OpenAiChatLlm(ctx, config, ctx.settings)
}
