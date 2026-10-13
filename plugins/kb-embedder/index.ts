// Serialized, resumable indexing. Chunks carry their model identity; a model
// switch cancels obsolete work and rebuilds only incompatible chunks.
import type { Context } from 'cordis'
import { KnowledgeIndexService, validEmbedding } from 'space-kb'
import type { KnowledgeIndexStatus } from 'space-kb'

declare module 'cordis' {
  interface Events {
    'space/kb-doc-added'(this: Context, payload: { docId: string }): void
    'space/embedding-config-changed'(this: Context): void
  }
}

export const name = 'kb-embedder'
export const inject = ['kb', 'embeddings', 'settings']
const BATCH = 16
const STATE_KEY = 'kb.embeddingIndex'

export class KnowledgeIndexer extends KnowledgeIndexService {
  private requested = false
  private active = false
  private disposed = false
  private controller?: AbortController
  private observedIdentity = ''
  private observedConfigured = false

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('space/kb-doc-added', () => this.retry())
    ctx.on('space/embedding-config-changed', () => this.checkConfiguration())
    ctx.effect(() => {
      // Covers env/plugin and legacy configuration paths as well as Admin.
      const timer = setInterval(() => this.checkConfiguration(), 1000)
      timer.unref()
      return () => { clearInterval(timer); this.disposed = true; this.controller?.abort() }
    })
    this.checkConfiguration()
  }

  private checkConfiguration() {
    const identity = this.ctx.embeddings.identity
    const configured = this.ctx.embeddings.configured
    if (identity === this.observedIdentity && configured === this.observedConfigured) return
    this.observedIdentity = identity
    this.observedConfigured = configured
    this.controller?.abort()
    this.retry()
  }

  retry() {
    if (this.disposed) return
    this.requested = true
    if (!this.active) void this.drain().catch(() => {
      console.error('[kb-embedder] 索引状态更新失败，请检查数据库后重试')
    })
  }

  async status(): Promise<KnowledgeIndexStatus> {
    const modelIdentity = this.ctx.embeddings.identity
    const { total, completed } = await this.ctx.kb.embeddingStats(modelIdentity)
    const previous = this.ctx.settings.get<KnowledgeIndexStatus | null>(STATE_KEY, null)
    const configured = this.ctx.embeddings.configured
    const state = !configured ? 'disabled' : completed === total ? 'ready'
      : previous?.modelIdentity === modelIdentity && ['running', 'failed'].includes(previous.state) ? previous.state : 'pending'
    return {
      state, modelIdentity, model: this.ctx.embeddings.model,
      total, completed,
      failed: state === 'failed' ? total - completed : 0,
      error: state === 'failed' ? previous?.error ?? '' : '',
      updatedAt: previous?.modelIdentity === modelIdentity ? previous.updatedAt : '',
    }
  }

  private async publish(state: KnowledgeIndexStatus['state'], identity: string, error = '') {
    if (this.disposed || this.ctx.embeddings.identity !== identity) return
    const current = await this.status()
    if (this.disposed || this.ctx.embeddings.identity !== identity) return
    this.ctx.settings.set(STATE_KEY, { ...current, state, error,
      failed: state === 'failed' ? current.total - current.completed : 0,
      updatedAt: new Date().toISOString(),
    })
  }

  private async drain() {
    this.active = true
    try {
      while (this.requested && !this.disposed) {
        this.requested = false
        await this.rebuild()
      }
    } finally { this.active = false }
  }

  private async rebuild() {
    const identity = this.ctx.embeddings.identity
    if (!this.ctx.embeddings.configured) { await this.publish('disabled', identity); return }
    const chunks = await this.ctx.kb.allChunks()
    const pending = chunks.filter((chunk) => chunk.embeddingModel !== identity || !validEmbedding(chunk.embedding))
    if (!pending.length) { await this.publish('ready', identity); return }
    this.controller = new AbortController()
    const controller = this.controller
    await this.publish('running', identity)
    console.log(`[kb-embedder] 开始索引模型 ${this.ctx.embeddings.model}，${pending.length} 个分块待重建`)
    try {
      let dimensions = chunks.find((chunk) => chunk.embeddingModel === identity && validEmbedding(chunk.embedding))?.embedding.length
      for (let offset = 0; offset < pending.length; offset += BATCH) {
        if (this.disposed) return
        if (this.ctx.embeddings.identity !== identity || controller.signal.aborted) { this.requested = true; return }
        const batch = pending.slice(offset, offset + BATCH)
        const vectors = await this.ctx.embeddings.embed(batch.map((chunk) => chunk.text), { expectedIdentity: identity, signal: controller.signal })
        if (this.disposed) return
        if (this.ctx.embeddings.identity !== identity || controller.signal.aborted) { this.requested = true; return }
        dimensions ??= vectors[0]?.length
        if (vectors.length !== batch.length || vectors.some((vector) => !validEmbedding(vector) || vector.length !== dimensions)) {
          throw new Error('invalid_embedding')
        }
        for (let index = 0; index < batch.length; index++) {
          if (this.ctx.embeddings.identity !== identity || controller.signal.aborted) { this.requested = true; return }
          await this.ctx.kb.updateEmbedding(batch[index]!.chunkId, vectors[index]!, identity)
        }
        await this.publish('running', identity)
      }
      const status = await this.status()
      if (status.modelIdentity !== identity || status.completed < status.total) this.requested = true
      else {
        await this.publish('ready', identity)
        console.log(`[kb-embedder] 索引完成：${status.completed}/${status.total} 个分块`)
      }
    } catch (error) {
      if (this.disposed) return
      if (this.ctx.embeddings.identity !== identity || controller.signal.aborted) { this.requested = true; return }
      const code = (error as { code?: string }).code
      const httpStatus = /^Embedding 返回 (\d{3})/.exec((error as Error).message)?.[1]
      const message = code === 'timeout' ? '向量服务响应超时；已完成的分块会保留，可重试剩余任务。'
        : code === 'insufficient_quota' ? `向量模型可用额度已耗尽${httpStatus ? `（HTTP ${httpStatus}）` : ''}。请在供应商控制台检查免费额度、余额与“仅使用免费额度”设置，或更换有可用额度的供应商；恢复后重试未完成索引。`
        : (error as Error).message === 'invalid_embedding' ? '向量服务返回了无效向量或不一致的维度，请检查模型配置后重试。'
          : `向量服务调用失败${httpStatus ? `（HTTP ${httpStatus}）` : ''}，请检查网络、地址、密钥和模型权限后重试；已完成的分块会保留。`
      await this.publish('failed', identity, message)
      console.error(`[kb-embedder] 索引失败：${message}`)
    } finally { if (this.controller === controller) this.controller = undefined }
  }
}

export function apply(ctx: Context) { new KnowledgeIndexer(ctx) }
