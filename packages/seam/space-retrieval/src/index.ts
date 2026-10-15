// seam/space-retrieval —— 检索层能力缝（2026-09-30 分层架构新增）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 plugins/space-retrieval 提供（ctx.retrieval）：把事件域（events
// FTS）与记忆域（memory）两个数据源统一成一个检索面。上层（上下文注入层、
// Agent 层）只问检索层一个问题，不关心命中的是历史消息还是记忆 ——
// 数据源的可替换性由本缝保证（换向量库只改本层实现）。
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { EventCitation } from 'space-event'

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

/** Separate verified evidence markers from the answer body for system-level rendering. */
export function extractCitedAnswer(answer: string, hits: readonly RetrievalHit[]): {
  text: string
  citations: EventCitation[]
} {
  const valid = new Map<string, EventCitation>()
  for (const hit of hits) {
    const title = hit.title?.trim() || (hit.source === 'kb' ? '知识库文档' : hit.source === 'memory' ? 'Agent 记忆' : '会话消息')
    valid.set(`${hit.source}:${hit.id}`, {
      source: hit.source, id: hit.id, title, sessionId: hit.sessionId,
      ...(hit.documentId ? { documentId: hit.documentId } : {}),
    })
    for (const id of hit.sourceEventIds ?? []) {
      valid.set(`event:${id}`, { source: 'event', id, title: '来源会话消息', sessionId: hit.sessionId })
    }
  }
  const citations: EventCitation[] = []
  const seen = new Set<string>()
  const text = answer.replace(/【来源:(event|memory|kb):([^】]+)】/gu, (_token, source: string, id: string) => {
    const citation = valid.get(`${source}:${id}`)
    if (citation && !seen.has(`${citation.source}:${citation.id}`)) {
      seen.add(`${citation.source}:${citation.id}`)
      citations.push(citation)
    }
    return ''
  }).trim()
  return { text, citations }
}

/** @deprecated Use extractCitedAnswer to persist the citations separately from Markdown. */
export function formatCitedAnswer(answer: string, hits: readonly RetrievalHit[]): string {
  return extractCitedAnswer(answer, hits).text
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
