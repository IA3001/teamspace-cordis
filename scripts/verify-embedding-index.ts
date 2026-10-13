import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { SqliteKnowledgeStore } from '../packages/impl/space-store-sqlite/src/kb.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { EmbeddingError, OpenAiEmbedding } from '../packages/impl/space-embedding-openai/src/index.ts'
import { KnowledgeIndexer } from '../plugins/kb-embedder/index.ts'
import { vectorRerank } from '../packages/seam/space-kb/src/index.ts'

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('index verification timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const config = { baseURL: 'https://embedding.invalid/v1/', model: 'A', apiKey: 'first-key', dimensions: 2 }
const adapter = new OpenAiEmbedding(new Context(), config)
const originalIdentity = adapter.identity
config.apiKey = 'second-key'
assert.equal(adapter.identity, originalIdentity, 'key rotation alone does not invalidate document vectors')
config.baseURL = config.baseURL.replace(/\/$/, '')
assert.equal(adapter.identity, originalIdentity, 'a trailing slash does not invalidate vectors')
config.model = 'B'
assert.notEqual(adapter.identity, originalIdentity, 'model changes invalidate vectors even at the same dimension')
const secondIdentity = adapter.identity
config.dimensions = 3
assert.notEqual(adapter.identity, secondIdentity, 'requested dimension changes invalidate vectors')
const thirdIdentity = adapter.identity
config.baseURL = 'https://other.invalid/v1'
assert.notEqual(adapter.identity, thirdIdentity, 'endpoint changes invalidate vectors')
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: {
    code: 'insufficient_quota', message: 'Free quota exhausted. sensitive-provider-detail',
  } }), { status: 403 })
  await assert.rejects(() => adapter.embed(['quota verification']), (error: unknown) => {
    assert.ok(error instanceof EmbeddingError)
    assert.equal(error.code, 'insufficient_quota')
    assert.match(error.message, /额度已耗尽/u)
    assert.ok(!error.message.includes('sensitive-provider-detail'), 'quota diagnostics do not expose the raw upstream response')
    return true
  })
} finally { globalThis.fetch = originalFetch }

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrations = loadMigrations(fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url)))
for (const migration of migrations.filter((migration) => migration.version < 34)) db.exec(migration.up)
const ctx = new Context()
new SqliteSettingsStore(ctx, db)
new SqliteKnowledgeStore(ctx, db)
for (let index = 0; index < 40; index++) await ctx.kb.addDocument(`Document ${index}`, `Searchable original text ${index}.`)
db.prepare('UPDATE kb_chunks SET embedding = ?').run(JSON.stringify([1, 0]))
for (const migration of migrations.filter((migration) => migration.version >= 34)) db.exec(migration.up)
assert.ok((await ctx.kb.allChunks()).every((chunk) => chunk.embeddingModel === '' && chunk.embedding.length === 2), 'migration preserves old vectors but leaves their unknown identity untrusted')

let identity = 'A'
let holdNext = false
let release: (() => void) | undefined
let failureModel = ''
let callsSinceSwitch = 0
let inFlight = 0
let maxInFlight = 0
const calls: Array<{ identity: string; count: number }> = []
const writes: Array<{ identity: string; chunkId: string }> = []
const update = ctx.kb.updateEmbedding.bind(ctx.kb)
ctx.kb.updateEmbedding = async (chunkId, vector, modelIdentity) => {
  writes.push({ identity: modelIdentity ?? '', chunkId })
  await update(chunkId, vector, modelIdentity)
}
Object.assign(ctx, { embeddings: {
  get configured() { return true },
  get identity() { return identity },
  get model() { return identity },
  embed: async (texts: string[], options?: { expectedIdentity?: string }) => {
    const snapshot = identity
    assert.equal(options?.expectedIdentity, snapshot, 'worker requests are pinned to their model identity')
    calls.push({ identity: snapshot, count: texts.length })
    callsSinceSwitch++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (holdNext) {
        holdNext = false
        // Deliberately ignore cancellation to emulate a provider sending a late response.
        await new Promise<void>((resolve) => { release = resolve })
      }
      if (snapshot === failureModel && callsSinceSwitch === 2) throw Object.assign(new Error('simulated provider failure'), { code: 'http_error' })
      return texts.map(() => snapshot === 'C' ? [0, 0, 1] : [1, 0])
    } finally { inFlight-- }
  },
} })
let scope = await ctx.plugin((context: Context) => { new KnowledgeIndexer(context) })
try {
  await until(async () => (await ctx.kbIndex.status()).state === 'ready')
  assert.equal((await ctx.kbIndex.status()).completed, 40)
  assert.equal(calls.filter((call) => call.identity === 'A').reduce((sum, call) => sum + call.count, 0), 40, 'legacy vectors with unknown provenance are re-embedded')
  assert.ok((await ctx.kb.allChunks()).every((chunk) => chunk.embeddingModel === 'A'))
  console.log('✓ Legacy data is re-indexed with a persisted model identity')

  const keyword = [{ docId: 'lexical', docTitle: 'Keyword', chunkId: 'keyword', text: 'original', score: 1 }]
  const rerank = async (queryIdentity: string, queryVector: number[], chunks = undefined as Awaited<ReturnType<typeof ctx.kb.allChunks>> | undefined) => vectorRerank('query', keyword, {
    modelIdentity: queryIdentity, currentModelIdentity: () => identity,
    chunks: chunks ?? await ctx.kb.allChunks(), embed: async () => [queryVector], topK: 5, titles: new Map(),
  })
  identity = 'B'; holdNext = true; callsSinceSwitch = 0
  ctx.emit('space/embedding-config-changed')
  await until(async () => Boolean(release))
  assert.deepEqual(await rerank('B', [1, 0]), keyword, 'same-dimensional vectors from another model are never mixed')
  identity = 'C'; callsSinceSwitch = 0
  ctx.emit('space/embedding-config-changed')
  release!(); release = undefined
  await until(async () => (await ctx.kbIndex.status()).state === 'ready')
  assert.ok(writes.every((write) => write.identity !== 'B'), 'late results from an obsolete model are discarded before persistence')
  assert.ok((await ctx.kb.allChunks()).every((chunk) => chunk.embeddingModel === 'C' && chunk.embedding.length === 3))
  assert.deepEqual(await rerank('C', [1, 0]), keyword, 'dimension mismatches fall back instead of truncating vectors')
  assert.deepEqual(await vectorRerank('query', keyword, {
    modelIdentity: 'C', currentModelIdentity: () => identity, chunks: await ctx.kb.allChunks(),
    embed: async () => { identity = 'query-switch'; return [[0, 0, 1]] }, topK: 5, titles: new Map(),
  }), keyword, 'switching models during query embedding also falls back safely')
  identity = 'C'
  console.log('✓ Switching while a request is in flight discards late vectors and safely rebuilds a new dimension')

  identity = 'D'; failureModel = 'D'; callsSinceSwitch = 0
  ctx.emit('space/embedding-config-changed')
  await until(async () => (await ctx.kbIndex.status()).state === 'failed')
  assert.equal((await ctx.kbIndex.status()).completed, 16)
  assert.equal((await ctx.kbIndex.status()).failed, 24)
  assert.deepEqual(await rerank('D', [1, 0]), keyword, 'a partially rebuilt index uses keyword retrieval')
  const alreadyWritten = writes.filter((write) => write.identity === 'D').map((write) => write.chunkId)
  failureModel = ''
  const beforeRetry = calls.length
  ctx.kbIndex.retry()
  await until(async () => (await ctx.kbIndex.status()).state === 'ready')
  assert.equal(calls.slice(beforeRetry).reduce((sum, call) => sum + call.count, 0), 24, 'retry consumes only unfinished chunks')
  assert.ok(alreadyWritten.every((id) => writes.filter((write) => write.identity === 'D' && write.chunkId === id).length === 1))
  console.log('✓ Failures expose progress and retries preserve already completed chunks')

  identity = 'E'; failureModel = 'E'; callsSinceSwitch = 0
  ctx.emit('space/embedding-config-changed')
  await until(async () => (await ctx.kbIndex.status()).state === 'failed')
  await scope.dispose()
  failureModel = ''
  const beforeRestart = calls.length
  scope = await ctx.plugin((context: Context) => { new KnowledgeIndexer(context) })
  await until(async () => (await ctx.kbIndex.status()).state === 'ready')
  assert.equal(calls.slice(beforeRestart).reduce((sum, call) => sum + call.count, 0), 24, 'restart resumes from persisted chunk identities')
  assert.equal(maxInFlight, 1, 'imports, retries and switches share a single serial worker')
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'kb.embeddingIndex'").get() as { value: string }
  assert.equal(JSON.parse(stored.value).state, 'ready')
  assert.equal((await ctx.kb.listDocuments()).length, 40, 're-indexing never modifies original documents')
  console.log('✓ Restart resumes unfinished indexing and progress is durable without overlapping API requests')
} finally {
  await scope.dispose()
  db.close()
}
