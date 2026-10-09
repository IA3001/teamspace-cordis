// space-retrieval —— 检索层（分层 L3）实现：event 域 + memory 域 + kb 域统一检索面。
//
// 语义（seam/space-retrieval 契约照表执法）：
//   · query 空白 → RetrievalError('empty_query')；会话不存在 → session_not_found。
//   · event 侧：ctx.eventLog.search(sessionId, query)（FTS5 trigram / LIKE 兜底
//     都封装在 eventLog 实现里，本层不重复实现检索算法）；粗排分：
//     kind==='message'（发言正文）1.0，其余（decision/approval/system）0.8。
//   · kb 侧：ctx.kb.search(query, { topK: limit })；粗排分恒 0.9 —— kb 是
//     **人工灌入**的权威知识，优先级介于 event 发言（1.0）与 memory（≤1.0
//     但基线 0.6）之间（2026-10-01 约定）。
//   · memory 侧：ctx.memory.search(`session:<id>`, query, limit)；粗排分：
//     0.6 + weight*0.4（记忆是旁注性质，天然低于发言正文，weight 高者靠前）。
//   · 三源命中合并按 score 降序、截 limit（缺省 8）—— 同一次查询内可比即可。
//   · 检索是**纯读**：绝不产生写副作用（铁律，见 seam 类注释）。
import type { Context } from 'cordis'
import { RetrievalError, RetrievalService } from 'space-retrieval'
import type { RetrievalHit, SearchOptions } from 'space-retrieval'
import type { MemoryItem } from 'space-memory'
import type { KbHit } from 'space-kb'
import { vectorRerank } from 'space-kb'
import type { SessionEvent } from 'space-event'

export const name = 'space-retrieval'
// 严格注入：session（会话存在性校验）+ eventLog（历史检索）+ memory（记忆检索）
// + kb（知识库检索，2026-10-01）。严格注入下依赖不满足则本插件不加载，
// 所以检索时 ctx.kb 必然就绪 —— 不需要运行时容错。
// embeddings（2026-10-06 A2）：知识库向量重排 —— kb 分块有向量时按余弦
// 相似度排序（语义相近、用词不同也能命中），无向量/服务不可用回落关键词。
export const inject = ['session', 'eventLog', 'memory', 'kb', 'embeddings']

export class RetrievalServiceImpl extends RetrievalService {
  /**
   * 知识库向量重排（A2，2026-10-06）：kb_chunks 已回填向量且 Embedding
   * 可用时，查询向量化后按余弦相似度取 topK，替换关键词粗排结果 ——
   * 语义相近、用词不同的内容也能命中。任何一步失败回落 keywordHits。
   */
  private async kbVectorRerank(query: string, keywordHits: KbHit[], limit: number): Promise<KbHit[]> {
    // 重排逻辑在 seam 纯函数（kb 插件的 /kb 页搜索共用同一份，2026-10-06）。
    if (!this.ctx.embeddings?.configured) return keywordHits
    const titles = new Map<string, string>(
      (await this.ctx.kb.listDocuments()).map((d) => [d.id, d.title]),
    )
    return vectorRerank(query, keywordHits, {
      chunks: await this.ctx.kb.allChunks(),
      embed: (texts) => this.ctx.embeddings.embed(texts),
      topK: limit,
      titles,
    })
  }

  async search(sessionId: string, query: string, opts?: SearchOptions): Promise<RetrievalHit[]> {
    // 1) query 拒空白（seam 错误分类法：只能抛 RetrievalError）。
    if (!query || !query.trim()) {
      throw new RetrievalError('empty_query', '检索 query 为空（纯空白），拒绝检索')
    }
    // 2) 会话必须存在（检索范围以会话为界）。
    if (!this.ctx.session.getSession(sessionId)) {
      throw new RetrievalError('session_not_found', `会话 ${sessionId} 不存在，无处可检索`)
    }
    const limit = opts?.limit ?? 8
    const sources = opts?.sources ?? ['event', 'memory', 'kb']
    const hits: RetrievalHit[] = []

    // 3) event 侧：历史消息全文检索（FTS/LIKE 都在 eventLog 实现里）。
    if (sources.includes('event')) {
      const events: SessionEvent[] = this.ctx.eventLog.search(sessionId, query)
      for (const e of events) {
        hits.push({
          source: 'event',
          id: e.id,
          sessionId: e.sessionId,
          text: e.text,
          ts: e.ts,
          // 粗排：发言正文 1.0，其余事件种类 0.8（同查询内可比即可）。
          score: e.kind === 'message' ? 1.0 : 0.8,
          authorId: e.authorId,
        })
      }
    }

    // 4) kb 侧：知识库全文检索（人工灌入的权威知识）。kb.search 实现层错误
    //    （如 empty_query 之外的底层故障）不该炸掉整个检索 —— 包 try 记 warn 后跳过。
    if (sources.includes('kb')) {
      try {
        const kbHits: KbHit[] = await this.kbVectorRerank(query, await this.ctx.kb.search(query, { topK: limit }), limit)
        for (const h of kbHits) {
          hits.push({
            source: 'kb',
            id: h.chunkId,
            sessionId,
            text: h.text,
            // ts：知识库命中无时间语义（KbHit 不带 createdAt），置空串。
            ts: '',
            // 粗排：恒 0.9 —— 介于 event 发言（1.0）与 memory（基线 0.6）之间。
            score: 0.9,
            authorId: null,
          })
        }
      } catch (e) {
        console.warn(`[space-retrieval] kb.search 失败，跳过知识库侧：${(e as Error)?.message ?? e}`)
      }
    }

    // 5) memory 侧：记忆全文检索。memory.search 可能抛 bad_scope 之外的实现层
    //    错误 —— 单侧数据源故障不该炸掉整个检索，包 try 记 warn 后跳过。
    if (sources.includes('memory')) {
      try {
        const items: MemoryItem[] = await this.ctx.memory.search(
          `session:${sessionId}`,
          query,
          limit,
        )
        for (const m of items) {
          hits.push({
            source: 'memory',
            id: m.id,
            sessionId,
            text: m.text,
            ts: m.createdAt,
            // 粗排：记忆基线 0.6，weight（0~1）越高越靠前，封顶 1.0。
            score: 0.6 + m.weight * 0.4,
            authorId: m.authorId,
          })
        }
      } catch (e) {
        console.warn(`[space-retrieval] memory.search 失败，跳过记忆侧：${(e as Error)?.message ?? e}`)
      }
    }

    // 6) 合并按 score 降序、截 limit（sort 稳定：同分保持插入序 event → kb → memory）。
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

export function apply(ctx: Context) {
  // Service 基类构造即 provide（ctx.retrieval，承 space-message 同款）。
  new RetrievalServiceImpl(ctx)
}
