// ctx.kb 的 sqlite 实现（知识库域，2026-10-01）。
// 语义契约见 seam/space-kb 类注释：addDocument 自动分块 + FTS/LIKE 双口径
// 检索 + 级联删除。表 DDL 唯一出处 migrations/0010_knowledge（断言 ⑧）。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { KnowledgeError, KnowledgeService, validEmbedding } from 'space-kb'
import type { KbDocument, KbDocumentDetail, KbFolder, KbHit, KbSearchOptions } from 'space-kb'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

// ── 分块常量（策略由实现定；seam 不管）─────────────────────────────────────
// 先按 Markdown 标题与段落切分，再合并到约 500 字符；超长段落按句子/词边界
// 拆分并保留少量重叠。每块带章节面包屑，检索结果脱离原文时仍保有结构语境。
const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 50

/**
 * Build a safe trigram query from natural-language input. FTS's default AND
 * between every query token made complete Chinese questions miss when even one
 * phrase differed from the source. Latin words stay intact; CJK runs expand to
 * overlapping trigrams so BM25 can rank by the amount of matching evidence.
 */
function trigramQuery(query: string): string {
  const safe = query.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const terms = new Set<string>()
  for (const token of safe.split(/\s+/u)) {
    if (terms.size >= 32) break
    const chars = [...token]
    const cjk = chars.some((char) => /\p{Script=Han}/u.test(char))
    if (cjk && chars.length > 3) {
      for (let i = 0; i <= chars.length - 3 && terms.size < 32; i++) terms.add(chars.slice(i, i + 3).join(''))
    } else if (chars.length >= 3) {
      terms.add(token)
    }
  }
  return [...terms].map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * Return a lexical coverage score instead of treating one matching trigram as
 * proof that an entire natural-language query is relevant. CJK terms are
 * scored by overlapping trigram coverage; Latin/numeric terms must occur as
 * whole tokens.
 */
function lexicalCoverage(query: string, haystack: string): number {
  const terms = query
    .split(/\s+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, '').toLocaleLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return 0
  const text = haystack.toLocaleLowerCase()
  let score = 0
  for (const term of terms) {
    const chars = [...term]
    if (chars.some((char) => /\p{Script=Han}/u.test(char))) {
      const grams = chars.length >= 3
        ? Array.from({ length: chars.length - 2 }, (_, index) => chars.slice(index, index + 3).join(''))
        : [term]
      const unique = [...new Set(grams)]
      const count = unique.filter((gram) => text.includes(gram)).length
      score += count > 0 ? count / unique.length : 0
    } else {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(text)) score++
    }
  }
  return score / terms.length
}

type MarkdownSection = { headings: string[]; blocks: string[] }

function headingPrefix(headings: string[]): string {
  if (headings.length === 0) return ''
  const full = headings.join(' › ')
  const bounded = full.length > 220 ? `${full.slice(0, 217)}…` : full
  return `[章节：${bounded}]\n`
}

function splitLongBlock(block: string, limit: number): string[] {
  if (block.length <= limit) return [block]
  const chunks: string[] = []
  let start = 0
  while (start < block.length) {
    const hardEnd = Math.min(start + limit, block.length)
    if (hardEnd === block.length) {
      chunks.push(block.slice(start).trim())
      break
    }
    const window = block.slice(start, hardEnd)
    const boundary = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf(' '),
    )
    const end = start + (boundary > limit * 0.55 ? boundary + 1 : limit)
    chunks.push(block.slice(start, end).trim())
    start = Math.max(start + 1, end - CHUNK_OVERLAP)
    while (start < block.length && /\s/u.test(block[start]!)) start++
  }
  return chunks.filter(Boolean)
}

/** Markdown-aware chunking; each body chunk carries its heading breadcrumb. */
function chunkText(text: string): string[] {
  const sections: MarkdownSection[] = [{ headings: [], blocks: [] }]
  const headings: string[] = []
  let paragraph: string[] = []
  const flushParagraph = () => {
    const body = paragraph.join('\n').trim()
    if (body) sections.at(-1)!.blocks.push(body)
    paragraph = []
  }

  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line.trim())
    if (heading) {
      flushParagraph()
      const level = heading[1]!.length
      headings.length = level - 1
      headings[level - 1] = heading[2]!.trim()
      sections.push({ headings: [...headings], blocks: [] })
    } else if (!line.trim()) {
      flushParagraph()
    } else {
      paragraph.push(line)
    }
  }
  flushParagraph()

  const chunks: string[] = []
  for (const section of sections) {
    if (!section.blocks.length) continue
    const prefix = headingPrefix(section.headings)
    const capacity = Math.max(80, CHUNK_SIZE - prefix.length)
    let body = ''
    const flushChunk = () => {
      const value = `${prefix}${body.trim()}`.trim()
      if (value) chunks.push(value)
      body = ''
    }
    for (const block of section.blocks) {
      for (const piece of splitLongBlock(block, capacity)) {
        if (body && body.length + piece.length + 2 > capacity) flushChunk()
        if (body) body += '\n\n'
        body += piece
      }
    }
    flushChunk()
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
    folderPath: (r.folder_path as string) ?? '',
  }
}

function toDocumentDetail(r: Row, chunkCount: number): KbDocumentDetail {
  return { ...toDocument(r, chunkCount), content: (r.content as string) ?? '' }
}

export class SqliteKnowledgeStore extends KnowledgeService {
  constructor(
    ctx: ConstructorParameters<typeof KnowledgeService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  async addDocument(title: string, text: string, source = 'manual', folderPath = ''): Promise<KbDocument> {
    if (!title || !title.trim()) {
      throw new KnowledgeError('empty_title', '文档标题为空（纯空白不写入）')
    }
    if (!text || !text.trim()) {
      throw new KnowledgeError('empty_text', '文档正文为空（纯空白不写入）')
    }
    const docId = randomUUID()
    const createdAt = now()
    const chunks = chunkText(text)
    this.assertFolder(folderPath)
    // 先插文档、后插块（2026-10-05 修）：kb_chunks.doc_id 外键引用
    // kb_documents —— 原实现先插块，FOREIGN KEY 约束必炸，灌文档路径
    // 从未通过过。
    this.db
      .prepare(
        `INSERT INTO kb_documents(id, title, source, size, created_at, content, folder_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(docId, title.trim(), source, text.length, createdAt, text, folderPath)
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
    return { id: docId, title: title.trim(), source, size: text.length, createdAt, chunkCount: chunks.length, folderPath }
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

  async getDocument(id: string): Promise<KbDocumentDetail> {
    const row = this.db.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM kb_documents d WHERE d.id = ?`,
    ).get(id) as Row | undefined
    if (!row) throw new KnowledgeError('not_found', `文档 ${id} 不存在`)
    return toDocumentDetail(row, Number(row.chunk_count))
  }

  async updateDocument(id: string, title: string, text: string, folderPath = ''): Promise<KbDocumentDetail> {
    if (!title?.trim()) throw new KnowledgeError('empty_title', '文档标题为空（纯空白不写入）')
    if (!text?.trim()) throw new KnowledgeError('empty_text', '文档正文为空（纯空白不写入）')
    this.assertFolder(folderPath)
    const existing = this.db.prepare('SELECT source FROM kb_documents WHERE id = ?').get(id) as Row | undefined
    if (!existing) throw new KnowledgeError('not_found', `文档 ${id} 不存在`)
    const createdAt = now()
    const chunks = chunkText(text)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE kb_documents SET title = ?, content = ?, size = ?, folder_path = ? WHERE id = ?')
        .run(title.trim(), text, text.length, folderPath, id)
      this.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(id)
      const insert = this.db.prepare(
        `INSERT INTO kb_chunks(id, doc_id, idx, text, embedding, created_at) VALUES (?, ?, ?, ?, '[]', ?)`,
      )
      for (let i = 0; i < chunks.length; i++) insert.run(randomUUID(), id, i, chunks[i], createdAt)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.ctx.emit('space/kb-doc-added', { docId: id })
    return this.getDocument(id)
  }

  async listFolders(): Promise<KbFolder[]> {
    return (this.db.prepare(
      `SELECT f.path, f.name, f.parent_path,
        (SELECT COUNT(*) FROM kb_documents d WHERE d.folder_path = f.path) AS document_count
       FROM kb_folders f ORDER BY f.parent_path, f.name COLLATE NOCASE`,
    ).all() as Row[]).map((row) => ({
      path: row.path as string,
      name: row.name as string,
      parentPath: row.parent_path as string,
      documentCount: Number(row.document_count),
    }))
  }

  async createFolder(name: string, parentPath = ''): Promise<KbFolder> {
    const folderName = name.trim()
    if (!folderName || /[\\/]/u.test(folderName) || folderName === '.' || folderName === '..') {
      throw new KnowledgeError('invalid_folder', '文件夹名称不能为空，也不能包含斜杠')
    }
    if (parentPath) this.assertFolder(parentPath)
    const path = parentPath ? `${parentPath}/${folderName}` : folderName
    this.db.prepare('INSERT INTO kb_folders(path, name, parent_path, created_at) VALUES (?, ?, ?, ?)')
      .run(path, folderName, parentPath, now())
    return { path, name: folderName, parentPath, documentCount: 0 }
  }

  private assertFolder(folderPath: string): void {
    if (folderPath && !this.db.prepare('SELECT 1 FROM kb_folders WHERE path = ?').get(folderPath)) {
      throw new KnowledgeError('invalid_folder', `文件夹 ${folderPath} 不存在`)
    }
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
    const q = query.trim().slice(0, 512)
    if (!q) {
      throw new KnowledgeError('empty_query', '知识检索 query 为空（纯空白），拒绝检索')
    }
    const topK = opts?.topK ?? 5
    // 双口径（照 eventlog.search 惯例）：FTS trigram 要求查询词 ≥ 3 字符，
    // 否则走 LIKE 兜底（2 字词如"敏捷""看板"）。
    let rows: Row[]
    const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    // Exact title hits are useful even when the title is not repeated in the
    // body chunk. They are returned before body matches and do not dilute the
    // query with unrelated chunks.
    const titleRows = this.db.prepare(
      `SELECT c.id AS chunk_id, c.doc_id, c.text, d.title AS doc_title
       FROM kb_documents d JOIN kb_chunks c ON c.doc_id = d.id
       WHERE d.title LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY d.created_at ASC, c.idx ASC LIMIT ?`,
    ).all(`%${escaped}%`, topK) as Row[]
    if ([...q].length >= 3) {
      const match = trigramQuery(q)
      if (match) {
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
          .all(match, 1000) as Row[]
      } else {
        rows = this.db
          .prepare(
            `SELECT c.id AS chunk_id, c.doc_id, c.text, d.title AS doc_title
             FROM kb_chunks c
             JOIN kb_documents d ON d.id = c.doc_id
             WHERE c.text LIKE ? ESCAPE '\\'
             ORDER BY c.created_at ASC
             LIMIT ?`,
          )
          .all(`%${escaped}%`, 1000) as Row[]
      }
    } else {
      rows = this.db
        .prepare(
          `SELECT c.id AS chunk_id, c.doc_id, c.text, d.title AS doc_title
           FROM kb_chunks c
           JOIN kb_documents d ON d.id = c.doc_id
           WHERE c.text LIKE ? ESCAPE '\\'
           ORDER BY c.created_at ASC
           LIMIT ?`,
        )
        .all(`%${escaped}%`, 1000) as Row[]
    }
    const candidates = new Map<string, { row: Row; coverage: number; title: boolean }>()
    const titleIds = new Set(titleRows.map((row) => row.chunk_id as string))
    for (const row of [...titleRows, ...rows]) {
      const title = titleIds.has(row.chunk_id as string)
      const coverage = Math.max(
        lexicalCoverage(q, row.text as string),
        lexicalCoverage(q, row.doc_title as string),
      )
      // A title match is exact substring evidence. Body results must contain
      // every Latin/numeric term; CJK phrases may be paraphrased, so rank them
      // by trigram coverage and require at least one matching trigram.
      const latinTerms = q.split(/\s+/u)
        .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
        .filter((term) => term && ![...term].some((char) => /\p{Script=Han}/u.test(char)))
      const latinCoverage = latinTerms.length === 0
        ? 1
        : lexicalCoverage(latinTerms.join(' '), `${row.text as string}\n${row.doc_title as string}`)
      const hasCjkQuery = /\p{Script=Han}/u.test(q)
      if (!title && (latinCoverage < 1 || (hasCjkQuery ? coverage === 0 : coverage < 1))) continue
      const key = row.chunk_id as string
      const previous = candidates.get(key)
      if (!previous || title || coverage > previous.coverage) candidates.set(key, { row, coverage, title })
    }
    rows = [...candidates.values()]
      .sort((a, b) => Number(b.title) - Number(a.title) || b.coverage - a.coverage)
      .slice(0, topK)
      .map(({ row }) => row)
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
  async updateEmbedding(chunkId: string, vector: number[], modelIdentity = ''): Promise<void> {
    if (modelIdentity && !validEmbedding(vector)) throw new Error('无效向量不能标记为已完成索引')
    this.db
      .prepare(`UPDATE kb_chunks SET embedding = ?, embedding_model = ? WHERE id = ?`)
      .run(JSON.stringify(vector), modelIdentity, chunkId)
  }

  async embeddingStats(modelIdentity: string): Promise<{ total: number; completed: number }> {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN embedding_model = ? AND json_array_length(embedding) > 0 THEN 1 ELSE 0 END), 0) AS completed
      FROM kb_chunks`).get(modelIdentity) as { total: number; completed: number }
    return { total: Number(row.total), completed: Number(row.completed) }
  }

  /** 取全部块（含 embedding 原始 JSON），供向量相似度扫描。 */
  async allChunks(): Promise<{ chunkId: string; docId: string; text: string; embedding: number[]; embeddingModel: string }[]> {
    const rows = this.db
      .prepare(`SELECT id, doc_id, text, embedding, embedding_model FROM kb_chunks ORDER BY doc_id, idx`)
      .all() as Row[]
    return rows.map((r) => ({
      chunkId: r.id as string,
      docId: r.doc_id as string,
      text: r.text as string,
      embedding: JSON.parse((r.embedding as string) || '[]') as number[],
      embeddingModel: String(r.embedding_model ?? ''),
    }))
  }
}
