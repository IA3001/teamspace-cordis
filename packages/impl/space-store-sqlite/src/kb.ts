// ctx.kb 的 sqlite 实现（知识库域，2026-10-01）。
// 语义契约见 seam/space-kb 类注释：addDocument 自动分块 + FTS/LIKE 双口径
// 检索 + 级联删除。表 DDL 唯一出处 migrations/0010_knowledge（断言 ⑧）。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { KnowledgeError, KnowledgeService } from 'space-kb'
import type { KbDocument, KbHit, KbSearchOptions } from 'space-kb'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

// ── 分块常量（策略由实现定；seam 不管）─────────────────────────────────────
// 滑窗分块：每块约 500 字符，相邻块重叠 50 字符 —— 重叠保证跨块的句子
// 至少在一块里完整出现，避免边界处检索漏命中。
const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 50

/** 滑窗分块：返回块文本数组（可能为空 —— 空文本在调用侧已拒）。 */
function chunkText(text: string): string[] {
  const chunks: string[] = []
  const step = CHUNK_SIZE - CHUNK_OVERLAP
  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + CHUNK_SIZE))
    if (i + CHUNK_SIZE >= text.length) break
  }
  return chunks.length > 0 ? chunks : [text]
}

function toDocument(r: Row, chunkCount: number): KbDocument {
  return {
    id: r.id as string,
    title: r.title as string,
    source: r.source as string,
    size: Number(r.size),
    createdAt: r.created_at as string,
    chunkCount,
  }
}

export class SqliteKnowledgeStore extends KnowledgeService {
  constructor(
    ctx: ConstructorParameters<typeof KnowledgeService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  async addDocument(title: string, text: string, source = 'manual'): Promise<KbDocument> {
    if (!title || !title.trim()) {
      throw new KnowledgeError('empty_title', '文档标题为空（纯空白不写入）')
    }
    if (!text || !text.trim()) {
      throw new KnowledgeError('empty_text', '文档正文为空（纯空白不写入）')
    }
    const docId = randomUUID()
    const createdAt = now()
    const chunks = chunkText(text)
    // 先插文档、后插块（2026-10-05 修）：kb_chunks.doc_id 外键引用
    // kb_documents —— 原实现先插块，FOREIGN KEY 约束必炸，灌文档路径
    // 从未通过过。
    this.db
      .prepare(
        `INSERT INTO kb_documents(id, title, source, size, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(docId, title, source, text.length, createdAt)
    // 逐块 INSERT（FTS 由 0010 的触发器自动同步）。
    const insert = this.db.prepare(
      `INSERT INTO kb_chunks(id, doc_id, idx, text, embedding, created_at)
       VALUES (?, ?, ?, ?, '[]', ?)`,
    )
    for (let i = 0; i < chunks.length; i++) {
      insert.run(randomUUID(), docId, i, chunks[i], createdAt)
    }
    // 通知向量回填方（kb-embedder 插件订阅；本 impl 不硬依赖 embeddings ——
    // 依赖会成环 store→embeddings→settings→store）。无人订阅 = 不回填。
    this.ctx.emit('space/kb-doc-added', { docId })
    return { id: docId, title, source, size: text.length, createdAt, chunkCount: chunks.length }
  }

  async listDocuments(): Promise<KbDocument[]> {
    // chunkCount 由 kb_chunks 的 idx 计数得出。
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunk_count
         FROM kb_documents d ORDER BY d.created_at ASC`,
      )
      .all() as Row[]
    return rows.map((r) => toDocument(r, Number(r.chunk_count)))
  }

  async removeDocument(id: string): Promise<void> {
    const doc = this.db.prepare(`SELECT id FROM kb_documents WHERE id = ?`).get(id)
    if (!doc) {
      throw new KnowledgeError('not_found', `文档 ${id} 不存在`)
    }
    // 块的级联删除由外键 ON DELETE CASCADE 兜底（连接开了外键约束）。
    this.db.prepare(`DELETE FROM kb_documents WHERE id = ?`).run(id)
  }

  async search(query: string, opts?: KbSearchOptions): Promise<KbHit[]> {
    const q = query.trim()
    if (!q) {
      throw new KnowledgeError('empty_query', '知识检索 query 为空（纯空白），拒绝检索')
    }
    const topK = opts?.topK ?? 5
    // 双口径（照 eventlog.search 惯例）：FTS trigram 要求查询词 ≥ 3 字符，
    // 否则走 LIKE 兜底（2 字词如"敏捷""看板"）。
    let rows: Row[]
    if (q.length >= 3) {
      // FTS MATCH 串消毒（2026-10-07）：@ : * 等在 fts5 query 语法里有含义，
      // 原样传入会 syntax error（如带 @ 的会议消息）。只保留字母/数字/汉字，
      // 其余折成空格；空串则跳过 FTS 走 LIKE。
      const safe = q.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      if (safe) {
        rows = this.db
          .prepare(
            `SELECT c.id AS chunk_id, c.doc_id, c.text, d.title AS doc_title
             FROM kb_chunks_fts f
             JOIN kb_chunks c ON c.rowid = f.rowid
             JOIN kb_documents d ON d.id = c.doc_id
             WHERE kb_chunks_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(safe, topK) as Row[]
      } else {
        rows = [] as Row[]
      }
    } else {
      const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
      rows = this.db
        .prepare(
          `SELECT c.id AS chunk_id, c.doc_id, c.text, d.title AS doc_title
           FROM kb_chunks c
           JOIN kb_documents d ON d.id = c.doc_id
           WHERE c.text LIKE ? ESCAPE '\\'
           ORDER BY c.created_at ASC
           LIMIT ?`,
        )
        .all(`%${escaped}%`, topK) as Row[]
    }
    // score 归一：FTS 无可信分数 → 常量 1.0 按命中顺序衰减 1.0/(1+rank)。
    // 向量重排在检索层做（space-retrieval 持有 embeddings 注入；本 impl 若
    // 依赖 embeddings 会成环 store→embeddings→settings→store，2026-10-06）。
    return rows.map((r, i) => ({
      docId: r.doc_id as string,
      docTitle: r.doc_title as string,
      chunkId: r.chunk_id as string,
      text: r.text as string,
      score: 1.0 / (1 + i),
    }))
  }

  // ── Embedding 回填位（供检索层做向量相似度；本任务不实现调用方）──────────
  /** 把某块的向量写进 embedding 列（JSON number[]）。向量模型与量纲由调用方定。 */
  async updateEmbedding(chunkId: string, vector: number[]): Promise<void> {
    this.db
      .prepare(`UPDATE kb_chunks SET embedding = ? WHERE id = ?`)
      .run(JSON.stringify(vector), chunkId)
  }

  /** 取全部块（含 embedding 原始 JSON），供向量相似度扫描。 */
  async allChunks(): Promise<{ chunkId: string; docId: string; text: string; embedding: number[] }[]> {
    const rows = this.db
      .prepare(`SELECT id, doc_id, text, embedding FROM kb_chunks ORDER BY doc_id, idx`)
      .all() as Row[]
    return rows.map((r) => ({
      chunkId: r.id as string,
      docId: r.doc_id as string,
      text: r.text as string,
      embedding: JSON.parse((r.embedding as string) || '[]') as number[],
    }))
  }
}
