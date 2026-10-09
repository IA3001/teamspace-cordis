// seam/space-kb —— 知识库能力缝（2026-10-01 分层架构新增）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 impl/space-store-sqlite 提供（ctx.kb）：文档灌入时自动分块落库、
// 全文检索（FTS trigram / LIKE 兜底），并向检索层预留向量回填接口。
// 知识库与记忆域的分工：memory 是会话/agent 的"旁注"（自动沉淀），kb 是
// **人工灌入**的权威知识（优先级介于 event 发言与 memory 之间）。
//
// 语义由实现定的部分（本缝不管）：分块策略（窗口/重叠）、向量模型与
// embedding 量纲。search 是**纯读** —— 绝不产生写副作用（铁律）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    kb: KnowledgeService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一份知识库文档。对应 kb_documents 表一行（正文按块存 kb_chunks）。 */
export interface KbDocument {
  id: string
  title: string
  /** 开放词表：'manual' | 'file' | 'url' | ...（缺省 'manual'）。 */
  source: string
  /** 原文字符数（分块前的长度）。 */
  size: number
  createdAt: string
  /** 分块数（实现负责维护）。 */
  chunkCount: number
}

/** 一次知识检索命中（粒度 = 块）。 */
export interface KbHit {
  docId: string
  docTitle: string
  chunkId: string
  /** 命中片段文本。 */
  text: string
  /** 粗排分（实现自定义量纲，只保证同一次查询内可比）。 */
  score: number
}

/** 检索选项。 */
export interface KbSearchOptions {
  /** 命中上限（缺省 5）。 */
  topK?: number
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type KnowledgeErrorCode = 'empty_title' | 'empty_text' | 'not_found' | 'empty_query'

export class KnowledgeError extends Error {
  constructor(
    public readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · addDocument：title/text 拒空白（empty_title / empty_text）；实现内自动
//     分块（策略实现自定，如滑窗+重叠）；doc.size = 原文字符数。
//   · removeDocument：级联删块；不存在 → not_found。
//   · search：全文检索块（FTS / LIKE 兜底由实现定）；query 空白 → empty_query。
//     **纯读**，绝不写库。分块与向量语义由实现定。
export abstract class KnowledgeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'kb')
  }

  /** 灌入一份文档（实现内自动分块），返回落定后的文档元信息。 */
  abstract addDocument(title: string, text: string, source?: string): Promise<KbDocument>

  /** 列出全部文档（按创建时间升序）。 */
  abstract listDocuments(): Promise<KbDocument[]>

  /** 删除一份文档（级联删块）。不存在 → not_found。 */
  abstract removeDocument(id: string): Promise<void>

  /** 全文检索知识块，按 score 降序返回 topK。 */
  abstract search(query: string, opts?: KbSearchOptions): Promise<KbHit[]>

  /** 取全部块（含 embedding 原始 JSON），供向量相似度扫描（A2）。 */
  abstract allChunks(): Promise<{ chunkId: string; docId: string; text: string; embedding: number[] }[]>

  /** 把某块的向量写进 embedding 列（JSON number[]）。向量模型与量纲由调用方定。 */
  abstract updateEmbedding(chunkId: string, vector: number[]): Promise<void>
}


// ── 向量重排（A2，2026-10-06）：纯函数，embed 由调用方注入 ────────────────
/**
 * 用余弦相似度对关键词命中做语义重排。任一前提不满足（无向量块 / 向量化
 * 失败）原样返回 keywordHits；有向量则取相似度 topK 替换。
 * embed 是调用方传入的向量化函数 —— 本缝零 IO，IO 责任在调用方。
 */
export async function vectorRerank(
  query: string,
  keywordHits: KbHit[],
  opts: {
    chunks: { chunkId: string; docId: string; text: string; embedding: number[] }[]
    embed(texts: string[]): Promise<number[][]>
    topK: number
    titles: Map<string, string>
  },
): Promise<KbHit[]> {
  try {
    const withVec = opts.chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
    if (withVec.length === 0) return keywordHits
    const [qvec] = await opts.embed([query.trim()])
    if (!Array.isArray(qvec) || qvec.length === 0) return keywordHits
    const cosine = (a: number[], b: number[]) => {
      let dot = 0, na = 0, nb = 0
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
      return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
    }
    return withVec
      .map((c) => ({ c, sim: cosine(qvec, c.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, opts.topK)
      .map(({ c, sim }) => ({
        docId: c.docId,
        docTitle: opts.titles.get(c.docId) ?? '',
        chunkId: c.chunkId,
        text: c.text,
        score: sim,
      }))
  } catch {
    return keywordHits
  }
}
