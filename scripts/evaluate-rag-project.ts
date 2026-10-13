// Retrieval evaluation over maintained repository documentation. The default mode
// is offline; --with-embeddings reads only configured embed.* settings from the
// production DB, while all corpus writes remain isolated in :memory:.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EmbeddingError, OpenAiEmbedding } from '../packages/impl/space-embedding-openai/src/index.ts'
import { Context } from 'cordis'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteKnowledgeStore } from '../packages/impl/space-store-sqlite/src/kb.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { RetrievalServiceImpl } from '../plugins/space-retrieval/index.ts'

const root = resolve(import.meta.dirname ?? '.', '..')
const corpus = [
  '.rules/IRON-RULES.md', 'docs/ARCHITECTURE.md', 'docs/DEPLOYMENT.md', 'docs/ROADMAP.md',
]
const cases = [
  { query: 'packages 依赖方向如何限制？', relevant: 'docs/ARCHITECTURE.md' },
  { query: 'Agent 创建不应依赖身份特判或专属插件的规则是什么？', relevant: '.rules/IRON-RULES.md' },
  { query: '生产发布前要运行哪些检查命令？', relevant: 'docs/DEPLOYMENT.md' },
  { query: '升级数据库后，代码回滚时如何恢复 schema 和备份？', relevant: 'docs/DEPLOYMENT.md' },
  { query: 'Web 页面是否允许手写 CSS、内联样式和颜色？', relevant: '.rules/IRON-RULES.md' },
  { query: '项目里程碑和当前已完成项目规划在哪里？', relevant: 'docs/ROADMAP.md' },
]

const db = new DatabaseSync(':memory:')
const withEmbeddings = process.argv.includes('--with-embeddings')
let sourceDb: DatabaseSync | undefined
try {
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of loadMigrations(resolve(root, 'packages/impl/space-store-sqlite/migrations'))) db.exec(migration.up)
  const ctx = new Context() as Context & Record<string, any>
  new SqliteSessionStore(ctx, db)
  new SqliteEventLog(ctx, db)
  new SqliteMemoryStore(ctx, db)
  new SqliteKnowledgeStore(ctx, db)
  let embeddings: OpenAiEmbedding | undefined
  if (withEmbeddings) {
    const sourcePath = resolve(process.env.DB_PATH ?? 'data/database.db')
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true })
    const sourceSettings = new SqliteSettingsStore(new Context(), sourceDb)
    const settings = new SqliteSettingsStore(ctx, db)
    for (const key of ['embed.apiKey', 'embed.baseURL', 'embed.model']) {
      const value = sourceSettings.get(key, '')
      if (value) settings.set(key, value)
    }
    embeddings = new OpenAiEmbedding(ctx, {}, settings)
    if (!embeddings.configured) throw new Error('Embedding 未配置；请先在管理后台的模型/API 页面配置并验证')
    Object.assign(ctx, { embeddings })
  } else {
    Object.assign(ctx, { embeddings: { configured: false } })
  }
  new RetrievalServiceImpl(ctx)
  const session = ctx.session.createSession({ id: 's_project_eval', title: 'Repository RAG evaluation' })
  for (const path of corpus) {
    const content = readFileSync(resolve(root, path), 'utf8')
    await ctx.kb.addDocument(path, content)
  }

  const evaluate = async (label: string) => {
    const ranks: number[] = []
    for (const item of cases) {
      const hits = await ctx.retrieval.search(session.id, item.query, { sources: ['kb'], limit: 30 })
      const rankedDocs = [...new Set(hits.map((hit: { title: string }) => hit.title))]
      const rank = rankedDocs.indexOf(item.relevant) + 1
      ranks.push(rank)
      console.log(`${label} ${rank ? `rank=${rank}` : 'MISS'} ${item.query}`)
    }
    const mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / cases.length
    const hitAt3 = ranks.filter((rank) => rank > 0 && rank <= 3).length / cases.length
    return { mrr, hitAt3 }
  }

  const keyword = await evaluate('keyword')
  console.log(`Keyword baseline: Hit@3=${(keyword.hitAt3 * 100).toFixed(1)}% MRR=${keyword.mrr.toFixed(3)}`)
  assert(keyword.hitAt3 >= 0.8, `project corpus keyword Hit@3 below 80% (${(keyword.hitAt3 * 100).toFixed(1)}%)`)
  assert(keyword.mrr >= 0.75, `project corpus keyword MRR below 0.75 (${keyword.mrr.toFixed(3)})`)

  if (withEmbeddings && embeddings) {
    const chunks = await ctx.kb.allChunks()
    const identity = embeddings.identity
    const vectors = await embeddings.embed(chunks.map((chunk: { text: string }) => chunk.text), { expectedIdentity: identity })
    for (let i = 0; i < chunks.length; i++) await ctx.kb.updateEmbedding(chunks[i]!.chunkId, vectors[i] ?? [], identity)
    console.log(`Embedded ${chunks.length} corpus chunks using the configured provider (credentials omitted).`)
    const hybrid = await evaluate('hybrid')
    console.log(`Hybrid retrieval: Hit@3=${(hybrid.hitAt3 * 100).toFixed(1)}% MRR=${hybrid.mrr.toFixed(3)}`)
  }
  assert.equal(cases.length, 6)
} catch (error) {
  if (error instanceof EmbeddingError) {
    console.error(`Embedding comparison unavailable (${error.code}); provider details suppressed.`)
  } else {
    console.error(`RAG project evaluation failed: ${(error as Error).message}`)
  }
  process.exitCode = 1
} finally {
  sourceDb?.close()
  db.close()
}
