// space-llm-openai —— space-llm 缝的 OpenAI 兼容实现（P8 下半场，2026-09-30）。
//
// 语义（seam 契约照表执法）：
//   · configured：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三件套齐且 key 非空
//     （每次读取现算 —— verify 可在进程内翻转 env，门禁不依赖真 key）。
//   · chat：单次 POST {base}/chat/completions（Authorization: Bearer <key>，
//     body = {model, messages}），返回 choices[0].message.content 原文。
//     **不自动重试**（承「不猜」）；超时缺省 60s（AbortSignal.timeout）；
//     失败抛 LlmError（http_error / timeout / not_configured / empty_response），
//     消息里**绝不含 key**。
//
// 依赖方向（lint:deps 断言①）：impl 只准依赖 seams —— 本包只依赖 space-llm。
import type { Context } from 'cordis'
import { LlmError, LlmService } from 'space-llm'
import type { ChatMessage, ChatOptions } from 'space-llm'
import { LLM_API_KEY_ENV, LLM_BASE_URL_ENV, LLM_MODEL_ENV } from 'space-llm'

/** 单次调用超时缺省值（60s，拍板口径）。 */
export const DEFAULT_TIMEOUT_MS = 60_000

export class OpenAiChatLlm extends LlmService {
  get configured(): boolean {
    return Boolean(
      process.env[LLM_API_KEY_ENV]?.trim()
      && process.env[LLM_BASE_URL_ENV]?.trim()
      && process.env[LLM_MODEL_ENV]?.trim(),
    )
  }

  async chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string> {
    const base = process.env[LLM_BASE_URL_ENV]?.trim()
    const key = process.env[LLM_API_KEY_ENV]?.trim()
    const model = process.env[LLM_MODEL_ENV]?.trim()
    if (!base || !key || !model) {
      throw new LlmError(
        'not_configured',
        `LLM 未配置：需要 ${LLM_BASE_URL_ENV} / ${LLM_API_KEY_ENV} / ${LLM_MODEL_ENV} 三件套（.env，key 不落日志）`,
      )
    }
    const url = `${base.replace(/\/+$/, '')}/chat/completions`
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message)) {
        throw new LlmError('timeout', `LLM 调用超时（${timeoutMs}ms，单次不重试）`)
      }
      throw new LlmError('http_error', `LLM 请求失败：${err.message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new LlmError('http_error', `LLM 返回 ${res.status}（单次不重试）：${text.slice(0, 200)}`)
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
    return content
  }
}

export const name = 'space-llm-openai'
// llm 是能力提供者本身，无上游服务依赖。
export const inject: string[] = []

export function apply(ctx: Context) {
  // Service 基类构造即 provide（承 agent-registry / workdir 同款）。
  new OpenAiChatLlm(ctx)
}
