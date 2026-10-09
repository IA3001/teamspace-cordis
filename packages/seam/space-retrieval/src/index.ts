// seam/space-retrieval —— 检索层能力缝（2026-09-30 分层架构新增）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 plugins/space-retrieval 提供（ctx.retrieval）：把事件域（events
// FTS）与记忆域（memory）两个数据源统一成一个检索面。上层（上下文注入层、
// Agent 层）只问检索层一个问题，不关心命中的是历史消息还是记忆 ——
// 数据源的可替换性由本缝保证（换向量库只改本层实现）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    retrieval: RetrievalService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一条检索命中。source 标明它来自哪个数据源。 */
export interface RetrievalHit {
  /**
   * 'event'（会话历史）| 'memory'（记忆域）| 'kb'（知识库，人工灌入的
   * 权威知识，2026-10-01 加入 —— 优先级介于 event 与 memory 之间）。
   */
  source: 'event' | 'memory' | 'kb'
  /** 原始记录 id（events.id / memories.id）。 */
  id: string
  /** Human-readable source label (document title, event sequence, or memory scope). */
  title?: string
  /** KB document id for navigating from a citation to its source document. */
  documentId?: string
  /** Durable event sources for event/memory hits, used for withdrawal propagation. */
  sourceEventIds?: string[]
  sessionId: string
  /** 命中片段文本。 */
  text: string
  ts: string
  /** 粗排分（实现自定义量纲，只保证同一次查询内可比）。 */
  score: number
  /** event 命中的作者（记忆命中为 authorId）。 */
  authorId: string | null
  /** Memory scope for private/session memory results. */
  scope?: string
}

/** Attach a verified source list and remove citations that do not match this call's evidence. */
export function formatCitedAnswer(answer: string, hits: readonly RetrievalHit[]): string {
  if (!hits.length) return answer
  const valid = new Set<string>()
  for (const hit of hits) {
    valid.add(`${hit.source}:${hit.id}`)
    for (const id of hit.sourceEventIds ?? []) valid.add(`event:${id}`)
  }
  const checked = answer.replace(/【来源:(event|memory|kb):([^】]+)】/gu, (token, source: string, id: string) =>
    valid.has(`${source}:${id}`) ? token : '【引用未通过来源核验】')
  const refs = hits.map((hit) => {
    const title = hit.title?.trim() || hit.source
    const docId = hit.documentId ? `，文档 ID ${hit.documentId}` : ''
    const events = hit.sourceEventIds?.length
      ? `，依据事件 ${hit.sourceEventIds.map((id) => `event:${id}`).join(', ')}`
      : ''
    return `- 【来源:${hit.source}:${hit.id}】${title}${docId}${events}`
  })
  return `${checked.trim()}\n\n参考来源（本轮检索命中）：\n${refs.join('\n')}`
}

/** 检索选项。 */
export interface SearchOptions {
  /** 命中上限（缺省 8）。 */
  limit?: number
  /** 过滤数据源（缺省三个都查：event / memory / kb）。 */
  sources?: ReadonlyArray<'event' | 'memory' | 'kb'>
  /** Select which memory scopes are searchable when `memory` is enabled. */
  memoryScopes?: ReadonlyArray<'session' | 'agent'>
  /** Include this Agent's private durable memories in addition to session memory. */
  agentId?: string
}

// ── 错误分类法 ───────────────────────────────────────────────────────────
export type RetrievalErrorCode = 'empty_query' | 'session_not_found'

export class RetrievalError extends Error {
  constructor(
    public readonly code: RetrievalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RetrievalError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · query 拒空白（empty_query）；会话不存在 → session_not_found。
//   · 命中合并后按 score 降序、截 limit；score 同查询内可比即可。
//   · 检索是纯读 —— 绝不产生写副作用。
export abstract class RetrievalService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'retrieval')
  }

  /** 在某会话范围内检索（历史 + 会话/Agent 记忆 + 团队知识库），按 score 降序返回。 */
  abstract search(sessionId: string, query: string, opts?: SearchOptions): Promise<RetrievalHit[]>
}
