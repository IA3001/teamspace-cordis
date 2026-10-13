// space-embedding-openai —— 文本向量服务的 OpenAI 兼容实现（2026-10-01）。
//
// 语义（仿 space-llm-openai 的 seam 契约口径）：
//   · configured：面板配置或 env（EMBED_API_KEY / EMBED_BASE_URL / EMBED_MODEL）
//     三件套齐且 key 非空（每次读取现算，不缓存）。
//   · embed：单次 POST {base}/embeddings（Authorization: Bearer <key>，
//     body = {model, input, dimensions?}），按 batchSize 分批调用，
//     返回 data[i].embedding（与输入顺序一一对应）。
//     **不自动重试**（承「不猜」）；失败抛 EmbeddingError
//     （not_configured / http_error / timeout / empty_response），消息里绝不含 key。
//
// 依赖方向（lint:deps 断言①）：impl 只准依赖 seams —— 本包不依赖任何业务缝。
import { Service } from 'cordis'
import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import { SettingsService } from 'space-settings'

/** 单次调用超时缺省值（60s，与 space-llm-openai 同口径）。 */
export const DEFAULT_TIMEOUT_MS = 60_000
/** 缺省分批大小（业界惯例，避免单请求过大被网关拒）。 */
export const DEFAULT_BATCH_SIZE = 16
/** 缺省模型（OpenAI 官方向量模型，业界事实标准）。 */
export const DEFAULT_MODEL = 'text-embedding-3-small'

// env 兜底常量（Embedding 可与 LLM 不同供应商，故独立一套 env）。
export const EMBED_API_KEY_ENV = 'EMBED_API_KEY'
export const EMBED_BASE_URL_ENV = 'EMBED_BASE_URL'
export const EMBED_MODEL_ENV = 'EMBED_MODEL'

/** 向量服务错误（仿 space-llm 的 LlmError 结构，本文件内定义）。 */
export class EmbeddingError extends Error {
  constructor(public readonly code: 'not_configured' | 'http_error' | 'timeout' | 'empty_response' | 'insufficient_quota', message: string) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/**
 * 配置面板 schema（5172 plugin-loader-webui 自动渲染）：
 * 配置值优先、env 兜底 —— 面板里留空即回退 .env 的 EMBED_* 三件套。
 */
export const Config = z.intersect([
  z.object({
    apiKey: z.string().role('secret').description('API Key（留空则回退 env EMBED_API_KEY）').default(''),
    baseURL: z.string().description('OpenAI 兼容 Base URL（留空回退 EMBED_BASE_URL）').default(''),
    model: z.string().description('向量模型名（留空回退 EMBED_MODEL）').default(''),
    dimensions: z.number().description('向量维度（可选，留 0 表示用模型缺省维度）').default(0),
    batchSize: z.number().min(1).max(128).description('单次请求最多多少条文本').default(16),
    timeoutMs: z.number().description('单次请求超时 ms').default(60000),
  }),
])

/** 运行时取值形状（面板/cordis 传来的 config 可能缺字段，全部按可选处理）。 */
export interface ConfigInput {
  apiKey?: string
  baseURL?: string
  model?: string
  dimensions?: number
  batchSize?: number
  timeoutMs?: number
}

declare module 'cordis' {
  interface Context {
    embeddings: EmbeddingService
  }
}

/** ctx.embeddings 服务缝：批量文本向量（调用方拿到的服务面）。 */
export abstract class EmbeddingService extends Service {
  /** 服务是否已配置（三件套齐且 key 非空）。 */
  abstract get configured(): boolean
  /** Model space identity excludes credentials and includes endpoint/model/dimensions. */
  abstract get identity(): string
  abstract get model(): string
  /** 批量向量：返回与 texts 等长的向量数组，顺序一一对应。 */
  abstract embed(texts: string[], options?: { expectedIdentity?: string; signal?: AbortSignal }): Promise<number[][]>
}

export class OpenAiEmbedding extends EmbeddingService {
  private readonly cfg: ConfigInput
  private readonly settings: SettingsService | null

  constructor(ctx: Context, config: ConfigInput = {}, settings?: SettingsService | null) {
    super(ctx, 'embeddings') // Service 基类构造即 provide 成 ctx.embeddings（名字必须显式给 —— cordis Service 构造签名 (ctx, name)）
    this.cfg = config
    // 设置缝可选注入（2026-10-05）：5172「模型与接入」页写入的 embed.* 键
    // 优先于本地 Config 与 env —— 面板改完即生效，无需重启。
    this.settings = settings ?? null
  }

  /** 取值优先级：settings（面板设置页）> Config > env 兜底（每次现算）。 */
  private resolve(): { key: string; base: string; model: string } {
    const s = this.settings
    return {
      key:
        (s && s.get<string>('embed.apiKey', '').trim()) ||
        this.cfg.apiKey?.trim() ||
        process.env[EMBED_API_KEY_ENV]?.trim() ||
        '',
      base:
        (s && s.get<string>('embed.baseURL', '').trim()) ||
        this.cfg.baseURL?.trim() ||
        process.env[EMBED_BASE_URL_ENV]?.trim() ||
        '',
      model:
        (s && s.get<string>('embed.model', '').trim()) ||
        this.cfg.model?.trim() ||
        process.env[EMBED_MODEL_ENV]?.trim() ||
        DEFAULT_MODEL,
    }
  }

  get configured(): boolean {
    const { key, base, model } = this.resolve()
    return Boolean(key && base && model)
  }

  get identity(): string {
    const { base, model } = this.resolve()
    return createHash('sha256').update(JSON.stringify([base.replace(/\/+$/, ''), model, Math.max(0, this.cfg.dimensions ?? 0)])).digest('hex')
  }
  get model(): string { return this.resolve().model }

  async embed(texts: string[], options?: { expectedIdentity?: string; signal?: AbortSignal }): Promise<number[][]> {
    if (options?.expectedIdentity && options.expectedIdentity !== this.identity) throw new EmbeddingError('not_configured', '向量模型已切换，取消旧模型请求')
    const { base, key, model } = this.resolve()
    if (!base || !key || !model) {
      throw new EmbeddingError(
        'not_configured',
        `Embedding 未配置：需要面板配置（apiKey/baseURL/model）或 ${EMBED_BASE_URL_ENV} / ${EMBED_API_KEY_ENV} / ${EMBED_MODEL_ENV} 三件套（key 不落日志）`,
      )
    }
    if (!Array.isArray(texts) || texts.length === 0) return []

    const batchSize = Math.max(1, Math.floor(this.cfg.batchSize ?? DEFAULT_BATCH_SIZE))
    const url = `${base.replace(/\/+$/, '')}/embeddings`
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 可选维度：0/负数视为未指定（用模型缺省维度）。
    const dimensions = this.cfg.dimensions && this.cfg.dimensions > 0 ? Math.floor(this.cfg.dimensions) : undefined

    const out: number[][] = []
    // 分批串行调用（不并发轰炸供应商；每批一次 POST，单次不重试）。
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const body: Record<string, unknown> = { model, input: batch }
      if (dimensions) body.dimensions = dimensions

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        const err = e as Error
        if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message)) {
          throw new EmbeddingError('timeout', `Embedding 调用超时（${timeoutMs}ms，单次不重试）`)
        }
        throw new EmbeddingError('http_error', `Embedding 请求失败：${err.message}`)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let providerCode = ''
        try {
          const payload = JSON.parse(text) as { error?: { code?: string; type?: string }; code?: string }
          providerCode = String(payload.error?.code || payload.error?.type || payload.code || '').toLowerCase()
        } catch { /* Preserve the normal HTTP failure when the response is not JSON. */ }
        if (providerCode === 'insufficient_quota') {
          throw new EmbeddingError('insufficient_quota', `Embedding 返回 ${res.status}：模型可用额度已耗尽；请在供应商控制台检查余额、免费额度与付费设置，或更换有可用额度的供应商。`)
        }
        throw new EmbeddingError('http_error', `Embedding 返回 ${res.status}（单次不重试）：${text.slice(0, 200)}`)
      }
      let payload: { data?: { index?: number; embedding?: unknown }[] }
      try {
        payload = (await res.json()) as typeof payload
      } catch (e) {
        throw new EmbeddingError('http_error', `Embedding 响应不是 JSON：${(e as Error).message}`)
      }
      const data = payload?.data
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new EmbeddingError('empty_response', `Embedding 响应缺 data 或条数不符（期望 ${batch.length}）`)
      }
      // 按服务端返回的 index 排序回填，保证与输入顺序一一对应。
      const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      for (const item of sorted) {
        if (!Array.isArray(item.embedding)) {
          throw new EmbeddingError('empty_response', 'Embedding 响应缺 data[i].embedding')
        }
        out.push(item.embedding as number[])
      }
    }
    return out
  }
}

export const name = 'space-embedding-openai'
// settings（2026-10-05）：5172 设置页写入的 embed.* 键优先于 Config/env。
export const inject: string[] = ['settings']

export function apply(ctx: Context, config: ConfigInput = {}) {
  new OpenAiEmbedding(ctx, config, ctx.settings)
}
