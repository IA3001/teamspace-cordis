import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteKnowledgeStore } from '../packages/impl/space-store-sqlite/src/kb.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { ContextAssemblyServiceImpl } from '../plugins/space-context/index.ts'
import { vectorRerank } from '../packages/seam/space-kb/src/index.ts'
import { extractCitedAnswer, formatCitedAnswer } from '../packages/seam/space-retrieval/src/index.ts'
import { RetrievalServiceImpl } from '../plugins/space-retrieval/index.ts'
import { apply as applyKbClient } from '../packages/client-ui/space-client-ui-kb/src/index.ts'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrationsDir)) db.exec(migration.up)

const ctx = new Context() as Context & Record<string, any>
new SqliteSessionStore(ctx, db)
new SqliteEventLog(ctx, db)
new SqliteMemoryStore(ctx, db)
new SqliteKnowledgeStore(ctx, db)
Object.assign(ctx, { embeddings: { configured: false } })
new RetrievalServiceImpl(ctx)
let kbRpc: Record<string, (...args: any[]) => Promise<any>> | null = null
Object.assign(ctx, {
  webui: { addEntry: (_entry: unknown, methods: Record<string, (...args: any[]) => Promise<any>>) => { kbRpc = methods } },
  users: { verifyToken: async (token: string) => token ? { id: 'u_rag' } : null },
})
applyKbClient(ctx)
Object.assign(ctx, { prompts: { get: () => ({ body: 'Team Agent system prompt' }) }, tools: { list: () => [] } })
new ContextAssemblyServiceImpl(ctx)
ctx.session.createSession({ id: 's_rag', title: 'RAG verification' })
const event = ctx.eventLog.append({
  id: 'evt_rag_source', sessionId: 's_rag', authorId: 'u_rag', phaseId: null,
  authorKind: 'human', kind: 'message', text: 'Bluebird deployment uses a local SQLite database.',
  mentions: [], toolCalls: [], replyMode: '',
})
const privateToolTrace = ctx.eventLog.append({
  id: 'evt_private_tool_trace', sessionId: 's_rag', authorId: null, phaseId: null,
  authorKind: 'system', kind: 'system', text: 'PrivateToolTraceNeedle hidden execution detail',
  mentions: [], toolCalls: [{ name: 'web.search', args: '{"query":"private"}', result: 'private tool output' }], replyMode: '',
})
await ctx.memory.remember('session:s_rag', 'confirmed_fact', 'Bluebird deployment uses SQLite.', {
  sourceEventId: event.id, authorId: 'u_rag',
})
await ctx.memory.remember('agent:a_rag', 'preference', 'The Agent prefers Bluebird local deployment.', {
  sourceEventId: event.id, authorId: 'a_rag',
})
const document = await ctx.kb.addDocument(
  'Bluebird 部署手册',
  'Bluebird deployment should keep SQLite on the persistent local volume and run one application process.',
)
const kbCountsBeforeBlankSearch = {
  documents: (db.prepare('SELECT COUNT(*) AS count FROM kb_documents').get() as { count: number }).count,
  chunks: (db.prepare('SELECT COUNT(*) AS count FROM kb_chunks').get() as { count: number }).count,
}
await assert.rejects(ctx.kb.search(' \t\n'), (error: { code?: string }) => error.code === 'empty_query',
  'knowledge search rejects a whitespace-only query with the empty_query error')
assert.deepEqual({
  documents: (db.prepare('SELECT COUNT(*) AS count FROM kb_documents').get() as { count: number }).count,
  chunks: (db.prepare('SELECT COUNT(*) AS count FROM kb_chunks').get() as { count: number }).count,
}, kbCountsBeforeBlankSearch, 'a rejected blank search does not write knowledge documents or chunks')
assert.deepEqual(await kbRpc!.searchKb('token-rag', ' \t\n'), { error: 'empty_query', detail: '检索词不能为空' },
  'the knowledge page RPC returns a stable empty_query error for whitespace-only input')
assert.deepEqual({
  documents: (db.prepare('SELECT COUNT(*) AS count FROM kb_documents').get() as { count: number }).count,
  chunks: (db.prepare('SELECT COUNT(*) AS count FROM kb_chunks').get() as { count: number }).count,
}, kbCountsBeforeBlankSearch, 'the rejected RPC search leaves the knowledge store unchanged')
const kbRpcHits = await kbRpc!.searchKb('token-rag', 'Bluebird') as Array<{ docId: string; source: string }>
assert(kbRpcHits.some((hit) => hit.docId === document.id && hit.source === 'manual'),
  'knowledge page search results carry the document source marker for presentation')
const structuredDocument = await ctx.kb.addDocument('运维手册结构验收', [
  '# Operations',
  '## Backup',
  `Backup archives must be copied to the recovery vault before the release window. ${'Keep one verified snapshot outside the application host. '.repeat(18)}`,
  '## Restore',
  `Restore drills must verify the persistent SQLite volume and document the recovery duration. ${'Record the observed result after each restore drill. '.repeat(18)}`,
].join('\n\n'))
const guideFolder = await ctx.kb.createFolder('团队资料')
const nestedFolder = await ctx.kb.createFolder('发布', guideFolder.path)
const editableDoc = await ctx.kb.addDocument('可编辑资料', '旧版专属口令蓝鲸七三一。', 'manual', nestedFolder.path)
assert.equal(editableDoc.folderPath, '团队资料/发布', 'new documents retain their selected folder path')
assert.equal((await ctx.kb.listFolders()).find((folder) => folder.path === nestedFolder.path)?.parentPath, guideFolder.path,
  'knowledge folders preserve their parent hierarchy')
assert.equal((await ctx.kb.getDocument(editableDoc.id)).content, '旧版专属口令蓝鲸七三一。', 'document detail returns the complete source content')
const editedDoc = await ctx.kb.updateDocument(editableDoc.id, '更新后的资料', '# 发布流程\n\n新版维护说明。', nestedFolder.path)
assert.equal(editedDoc.content, '# 发布流程\n\n新版维护说明。', 'document edits persist the exact Markdown source')
assert.equal(editedDoc.title, '更新后的资料', 'document edits update the title')
assert((await ctx.kb.search('新版维护说明')).some((hit) => hit.docId === editableDoc.id),
  'edited content is searchable after chunk and FTS index rebuild')
assert.equal((await ctx.kb.search('蓝鲸七三一')).some((hit) => hit.docId === editableDoc.id), false,
  'search no longer returns chunks from the previous document version')
const structuredChunks = (await ctx.kb.allChunks()).filter((chunk) => chunk.docId === structuredDocument.id)
assert(structuredChunks.length >= 4, 'long structured guidance is split into multiple chunks')
assert(structuredChunks.every((chunk) => chunk.text.length <= 500), 'heading context remains inside the chunk size budget')
const backupChunks = structuredChunks.filter((chunk) => chunk.text.includes('[章节：Operations › Backup]'))
const restoreChunks = structuredChunks.filter((chunk) => chunk.text.includes('[章节：Operations › Restore]'))
assert(backupChunks.length > 0 && backupChunks.every((chunk) => chunk.text.includes('[章节：Operations › Backup]')),
  'every backup chunk carries its full Markdown heading path')
assert(restoreChunks.length > 0 && restoreChunks.every((chunk) => chunk.text.includes('[章节：Operations › Restore]')),
  'every restore chunk carries its full Markdown heading path')
assert(backupChunks.every((chunk) => !chunk.text.includes('Restore drills')) &&
  restoreChunks.every((chunk) => !chunk.text.includes('Backup archives')),
  'sibling sections are never merged across Markdown headings')

const hits = await ctx.retrieval.search('s_rag', 'Bluebird', { agentId: 'a_rag', limit: 8 })
assert(hits.some((hit) => hit.source === 'event' && hit.id === event.id), 'retrieval includes matching session events')
assert(hits.some((hit) => hit.source === 'kb' && hit.title === document.title && hit.documentId === document.id),
  'retrieval preserves KB document title and id for citations')
assert(hits.some((hit) => hit.source === 'memory' && hit.scope === 'session:s_rag'),
  'retrieval searches session memory')
assert(hits.some((hit) => hit.source === 'memory' && hit.scope === 'agent:a_rag'),
  'Agent-scoped RAG searches private durable memory')
assert.deepEqual(new Set(hits.find((hit) => hit.source === 'memory' && hit.scope === 'agent:a_rag')?.sourceEventIds),
  new Set([event.id]), 'memory retrieval retains causal event provenance')

const sessionOnly = await ctx.retrieval.search('s_rag', 'Bluebird', { limit: 8 })
assert.equal(sessionOnly.some((hit) => hit.scope === 'agent:a_rag'), false,
  'private Agent memory is never returned without an explicit agentId')
for (const [query, requiredSources] of [
  ['SQLite', ['event', 'kb', 'memory']],
  ['local', ['event', 'kb', 'memory']],
] as const) {
  const result = await ctx.retrieval.search('s_rag', query, { agentId: 'a_rag', limit: 8 })
  for (const source of requiredSources) {
    assert(result.some((hit) => hit.source === source), `${query} retrieves the expected ${source} source`)
  }
}
const assembled = await ctx.context.assemble('s_rag', { query: 'Bluebird', agentId: 'a_rag', memoryLimit: 0 })
assert(assembled.retrieval.some((hit: { scope?: string }) => hit.scope === 'agent:a_rag'),
  'context assembly passes Agent identity through to private-memory retrieval')
const recentAndRag = await ctx.context.assemble('s_rag', { query: 'Bluebird', agentId: 'a_rag' })
const recentIds = new Set(recentAndRag.memories.map((item: { id: string }) => item.id))
assert.equal(recentAndRag.retrieval.some((hit: { source: string; id: string }) =>
  hit.source === 'memory' && recentIds.has(hit.id)), false,
'the context does not duplicate memory hits already injected through recent recall')

const sessionContext = await ctx.context.assemble('s_rag', {
  query: 'Bluebird', agentId: 'a_rag', contextSources: ['session'], recentLimit: 100,
})
assert(sessionContext.history.some((item: { id: string }) => item.id === event.id),
  'session source includes session history')
assert(sessionContext.memories.some((item: { scope: string }) => item.scope === 'session:s_rag'),
  'session source includes session memory')
assert.equal(sessionContext.history.some((item: { id: string }) => item.id === privateToolTrace.id), false,
  'human-facing tool activity is excluded from Agent conversation history')
assert(sessionContext.retrieval.every((hit: { source: string; scope?: string }) =>
  hit.source === 'event' || (hit.source === 'memory' && hit.scope === 'session:s_rag')),
  'session source retrieval excludes Agent memory and team KB')
const privateTraceHits = await ctx.retrieval.search('s_rag', 'PrivateToolTraceNeedle', { sources: ['event'] })
assert.equal(privateTraceHits.some((hit) => hit.id === privateToolTrace.id), false,
  'Agent RAG cannot retrieve human-only tool activity')
assert(ctx.eventLog.listBySession('s_rag').some((item: { id: string }) => item.id === privateToolTrace.id),
  'tool activity remains in the shared event stream for human activity UI')

const agentMemoryContext = await ctx.context.assemble('s_rag', {
  query: 'Bluebird', agentId: 'a_rag', contextSources: ['agent-memory'],
})
assert.equal(agentMemoryContext.history.length, 0, 'Agent-memory-only source excludes session history')
assert(agentMemoryContext.memories.every((item: { scope: string }) => item.scope === 'agent:a_rag'),
  'Agent-memory-only source recalls only this Agent’s private memory')
assert(agentMemoryContext.retrieval.every((hit: { source: string; scope?: string }) =>
  hit.source === 'memory' && hit.scope === 'agent:a_rag'),
  'Agent-memory-only retrieval excludes session events, session memory, and team KB')

const kbContext = await ctx.context.assemble('s_rag', {
  query: 'Bluebird', agentId: 'a_rag', contextSources: ['team-kb'],
})
assert.equal(kbContext.history.length, 0, 'team-KB-only source excludes session history')
assert.equal(kbContext.memories.length, 0, 'team-KB-only source excludes durable memory')
assert(kbContext.retrieval.length > 0 && kbContext.retrieval.every((hit: { source: string }) => hit.source === 'kb'),
  'team-KB-only retrieval includes KB and excludes events and memories')

// Live panel todos must not depend on a matching query or the generic memory limit.
ctx.session.createSession({ id: 's_todos', title: 'Team todo context verification' })
const todoContext = (contextSources: string[] = ['session']) => ctx.context.assemble('s_todos', {
  contextSources, recentLimit: 0, memoryLimit: 0,
})
assert((await todoContext()).system.includes('当前没有团队待办。'), 'empty todo state is explicit')
const todo = await ctx.memory.remember('session:s_todos', 'todo', JSON.stringify({ done: false, text: '吃饭' }), { weight: 0.8 })
for (let i = 0; i < 12; i++) await ctx.memory.remember('session:s_todos', 'note', `高权重普通记忆 ${i}`, { weight: 1 })
await ctx.memory.remember('session:s_rag', 'todo', JSON.stringify({ done: false, text: '其他会话的私有待办' }))
await ctx.memory.remember('session:s_todos', 'todo', '损坏的待办载荷')
const liveTodoContext = await todoContext()
assert(liveTodoContext.system.includes('[未完成] "吃饭"'), 'the Agent sees panel todos even with memory recall disabled')
assert(!liveTodoContext.system.includes('其他会话的私有待办'), 'todo context never leaks another session')
assert(!liveTodoContext.system.includes('损坏的待办载荷'), 'invalid todo rows do not corrupt the readable snapshot')
assert(!(await todoContext(['agent-memory'])).system.includes('吃饭'), 'session context opt-out also excludes its todos')
await ctx.memory.forget(todo.id)
const doneTodo = await ctx.memory.remember('session:s_todos', 'todo', JSON.stringify({ done: true, text: '吃饭' }), { weight: 0.8 })
const doneContext = await todoContext()
assert(doneContext.system.includes('[已完成] "吃饭"') && !doneContext.system.includes('[未完成] "吃饭"'),
  'the next call reads the updated status instead of stale recalled state')
await ctx.memory.forget(doneTodo.id)
assert((await todoContext()).system.includes('当前没有团队待办。'), 'deleted todos disappear on the next call')
const originalRecall = ctx.memory.recall.bind(ctx.memory)
ctx.memory.recall = async (scope: string, options: { kind?: string } = {}) => {
  if (options.kind === 'todo') throw new Error('simulated todo read failure')
  return originalRecall(scope, options)
}
try {
  const unavailable = await todoContext()
  assert(unavailable.system.includes('本次读取失败，待办状态未知') && !unavailable.system.includes('当前没有团队待办。'),
    'a failed todo read must not be reported to the Agent as an empty todo list')
} finally { ctx.memory.recall = originalRecall }

const kbHit = hits.find((hit) => hit.source === 'kb')!
const cited = extractCitedAnswer(`方案依据文档。 【来源:kb:${kbHit.id}】 【来源:kb:invented】`, [kbHit])
assert.equal(cited.text, '方案依据文档。', 'citation markers are removed from the Markdown answer body')
assert.equal(formatCitedAnswer(`方案依据文档。 【来源:kb:${kbHit.id}】`, [kbHit]), cited.text,
  'deprecated string API remains callable and returns the clean answer body')
assert.deepEqual(cited.citations.map(({ source, id, title }) => ({ source, id, title })), [
  { source: 'kb', id: kbHit.id, title: 'Bluebird 部署手册' },
], 'only validated references are returned as structured UI metadata')
const citedEvent = ctx.eventLog.append({
  id: 'evt_cited_answer', sessionId: 's_rag', authorId: 'a_rag', phaseId: null,
  authorKind: 'agent', kind: 'message', text: cited.text, citations: cited.citations,
  mentions: [], toolCalls: [], replyMode: '',
})
assert.deepEqual(citedEvent.citations, cited.citations, 'structured citations survive event persistence and reload')

const hybrid = await vectorRerank('semantic query', [
  { docId: 'd1', docTitle: 'Keyword doc', chunkId: 'c_keyword', text: 'lexical match', score: 1 },
], {
  chunks: [
    { docId: 'd1', chunkId: 'c_keyword', text: 'lexical match', embedding: [0, 1], embeddingModel: 'test-model' },
    { docId: 'd2', chunkId: 'c_semantic', text: 'semantic match', embedding: [1, 0], embeddingModel: 'test-model' },
  ],
  modelIdentity: 'test-model',
  embed: async () => [[1, 0]],
  topK: 2,
  titles: new Map([['d1', 'Keyword doc'], ['d2', 'Semantic doc']]),
})
assert.deepEqual(new Set(hybrid.map((hit) => hit.chunkId)), new Set(['c_keyword', 'c_semantic']),
  'hybrid ranking retains lexical evidence and adds semantically similar chunks')
assert.equal(hybrid[0]?.chunkId, 'c_semantic', 'semantic match can outrank a weak-vector keyword hit')

ctx.eventLog.void(event.id, 'u_rag', 'retrieval withdrawal check')
await ctx.memory.forgetBySource(event.id)
const afterWithdrawal = await ctx.retrieval.search('s_rag', 'Bluebird', { agentId: 'a_rag', limit: 8 })
assert.equal(afterWithdrawal.some((hit) => hit.source === 'event' && hit.id === event.id), false,
  'retrieval excludes withdrawn events')
assert.equal(afterWithdrawal.some((hit) => hit.source === 'memory'), false,
  'retrieval excludes memories invalidated by source withdrawal')

console.log('✓ RAG searches event, KB, session and private Agent memory; hybrid ranking, source citations, and withdrawal verified')
db.close()
