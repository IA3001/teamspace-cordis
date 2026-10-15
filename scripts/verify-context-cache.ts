import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { SessionEvent } from 'space-event'
import type { ChatUsage } from 'space-llm'
import { ContextAssemblyServiceImpl } from '../plugins/space-context/index.ts'
import { cacheFriendlyMessages } from '../packages/impl/space-agent-runtime/src/cache-context.ts'
import { OpenAiChatLlm } from '../packages/impl/space-llm-openai/src/index.ts'

const events: SessionEvent[] = Array.from({ length: 30 }, (_, i) => ({
  id: `event-${i}`, sessionId: 'test', seq: i + 1, ts: '2026-10-15T00:00:00Z', authorId: 'human', authorKind: 'human',
  kind: 'message', text: `history-${i}`, mentions: [], toolCalls: [], replyMode: '', voided: false,
} as SessionEvent))
let todo = 'first-todo'
const ctx = Object.assign(new Context(), {
  session: { getSession: () => ({ id: 'test' }) }, eventLog: { listBySession: () => events },
  prompts: { get: () => ({ body: 'Stable agent instructions' }) }, tools: { list: () => [{ id: 'z', title: 'Z' }, { id: 'a', title: 'A' }] },
  memory: { recall: async (_scope: string, options: { kind?: string }) => options.kind === 'todo'
    ? [{ id: 'todo', text: JSON.stringify({ done: false, text: todo }), createdAt: '2026-10-15' }] : [] },
  retrieval: { search: async () => [] },
})
const service = new ContextAssemblyServiceImpl(ctx)
const assemble = () => service.assemble('test', { persona: 'Agent A', toolIds: ['a'], recentLimit: 30, historyMode: 'cache-blocks' })
const first = await assemble()
todo = 'changed-todo'
events.push({ ...events[0]!, id: 'new', seq: 31, text: 'new message' })
const second = await assemble()
assert.equal(second.stableSystem, first.stableSystem, 'changing live todos never alters stable system prefix')
assert.equal(first.stableSystemSections?.map((section) => section.content).join('\n\n'), first.stableSystem,
  'source-labelled stable prompt segments reconstruct the exact cached system prompt')
assert.equal(second.dynamicContextSections?.map((section) => section.content).join('\n\n'), second.dynamicContext,
  'source-labelled live context segments reconstruct the exact injected dynamic context')
assert(!second.stableSystem?.includes('changed-todo'))
assert(second.dynamicContext?.includes('changed-todo'), 'live data is still read fresh')
assert(!second.stableSystem?.includes('z —'), 'only permitted tools enter the prefix')
const messages = (value: typeof first, task: string) => cacheFriendlyMessages(value.stableSystem!, value.history.map(e => ({ role: 'user', content: e.text })), value.dynamicContext!, task)
const before = messages(first, 'task one'), after = messages(second, 'task two')
assert.deepEqual(after.slice(0, before.length - 2), before.slice(0, -2), 'a new message appends without changing the previous stable history prefix')
assert.equal(after.at(-2)?.content.includes('changed-todo'), true)
assert.equal(after.at(-1)?.content, '任务：task two')
// The old sliding window would fail the same equality when the 31st message arrives.
assert.notDeepEqual(events.slice(-30).slice(0, 29).map(e => e.id), first.history.slice(0, 29).map(e => e.id))
for (let i = 32; i <= 38; i++) events.push({ ...events[0]!, id: `new-${i}`, seq: i, text: `new-${i}` })
for (const historyMode of [undefined, 'cache-blocks'] as const) {
  assert.equal((await service.assemble('test', { historyMode, recentLimit: 0 })).history.length, 0, 'zero history never includes a partial cache block')
}
const boundary = await assemble()
assert.equal(boundary.history[0]?.seq, 9, 'history rolls only at a block boundary')
assert.equal(boundary.history.length, 30)
const bounded = await service.assemble('test', { historyMode: 'cache-blocks', charBudget: 320, recentLimit: 30 })
assert(bounded.approxChars <= 320, 'block retention respects the existing character budget')
events[events.length - 1]!.voided = true
assert(!(await assemble()).history.some(e => e.seq === 38), 'withdrawn messages are never reused from stale history')
assert.notEqual((await service.assemble('test', { persona: 'Agent B' })).stableSystem, first.stableSystem, 'Agent identities do not share the same persona prefix')

const originalFetch = globalThis.fetch
const llm = new OpenAiChatLlm(new Context(), { baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' })
let usage: ChatUsage | undefined
try {
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream_options.include_usage, true)
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1536}}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  assert.equal(await llm.chat([{ role: 'user', content: 'test' }], { onToken: () => {}, onUsage: value => { usage = value } }), 'hello')
  assert.equal(usage?.cachedInputTokens, 1536, 'usage-only final SSE frames are preserved')
  assert.equal(usage?.inputTokens, 2000)
  assert.equal(typeof usage?.firstTokenMs, 'number')
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }))
  await llm.chat([{ role: 'user', content: 'test' }], { onUsage: value => { usage = value } })
  assert.equal(usage?.cachedInputTokens, undefined, 'missing cache data is unknown rather than zero or stale usage')
  assert.equal(await llm.chat([], { onUsage: () => { throw new Error('telemetry failure') } }), 'done', 'telemetry never breaks successful work')
} finally { globalThis.fetch = originalFetch }
console.log('✓ Stable prefix, fresh live data, block history, budget, withdrawal and provider cache usage verified')
