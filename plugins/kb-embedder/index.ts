// kb-embedder —— 知识库向量回填器（A2，2026-10-06）。
//
// 职责：监听 'space/kb-doc-added'（kb 实现灌完文档后发），把该文档的全部
// 分块经 Embedding 服务向量化，写回 kb_chunks.embedding（kb.updateEmbedding）。
// 启动时还做一次**全库扫尾**：补齐 embeddings 服务此前不可用期间漏回填的块。
//
// 为什么是独立插件而不是 store 顺手做：store 依赖 embeddings 会成环
// （store→embeddings→settings→store）；事件驱动 + 独立消费方是环外的。
//
// 失败口径：Embedding 未配置 / 调用失败 → 静默跳过（检索层自动用关键词
// 兜底，见 kb.ts search），console.error 留一条痕，绝不重试。
import type { Context } from 'cordis'
import { LlmError } from 'space-llm'

declare module 'cordis' {
  interface Events {
    'space/kb-doc-added'(this: Context, payload: { docId: string }): void
  }
}

export const name = 'kb-embedder'
export const inject = ['kb', 'embeddings']

const BATCH = 16

export function apply(ctx: Context) {
  /** 回填一个文档的全部未回填块。 */
  async function backfillDoc(docId: string) {
    const all = await ctx.kb.allChunks()
    const pending = all.filter((c) => c.docId === docId && (!Array.isArray(c.embedding) || c.embedding.length === 0))
    if (pending.length === 0) return
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH)
      const vectors = await ctx.embeddings.embed(batch.map((c) => c.text))
      for (let j = 0; j < batch.length; j++) {
        await ctx.kb.updateEmbedding(batch[j]!.chunkId, vectors[j] ?? [])
      }
    }
    console.log(`[kb-embedder] 文档 ${docId} 已回填 ${pending.length} 块向量`)
  }

  ctx.on('space/kb-doc-added', ({ docId }: { docId: string }) => {
    if (!ctx.embeddings.configured) return
    void backfillDoc(docId).catch((e: unknown) => {
      const code = (e as LlmError).code ?? ''
      console.error(`[kb-embedder] 回填失败（${code || 'unknown'}）：${(e as Error).message}`)
    })
  })

  // 启动扫尾：把历史漏回填的块补齐（逐文档处理，失败不阻塞其他文档）。
  void (async () => {
    if (!ctx.embeddings.configured) return
    try {
      const all = await ctx.kb.allChunks()
      const docIds = [...new Set(all.filter((c) => !Array.isArray(c.embedding) || c.embedding.length === 0).map((c) => c.docId))]
      for (const docId of docIds) {
        try { await backfillDoc(docId) } catch (e) {
          console.error(`[kb-embedder] 扫尾回填失败（${docId}）：${(e as Error).message}`)
        }
      }
      if (docIds.length) console.log(`[kb-embedder] 启动扫尾完成（${docIds.length} 个文档）`)
    } catch (e) {
      console.error(`[kb-embedder] 启动扫尾异常：${(e as Error).message}`)
    }
  })()

  console.log(`[kb-embedder] 就绪：灌文档自动向量化（Embedding ${ctx.embeddings.configured ? '可用' : '未配置，待配置后扫尾补齐'}）`)
}
