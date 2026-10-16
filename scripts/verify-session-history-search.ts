import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { SessionEvent } from 'space-event'
import { ToolRegistry } from '../plugins/space-tool/index.ts'
import { apply as applyHistorySearch } from '../plugins/tool-session-history-search/index.ts'

const events = (sessionId: string): SessionEvent[] => [
  {
    id: 'evt-1', sessionId, seq: 1, phaseId: null, ts: '2026-10-16T01:00:00.000Z',
    authorId: 'u_alice', authorKind: 'user', kind: 'message', text: '发布网关需要灰度验证', mentions: [], toolCalls: [],
    replyMode: 'normal', sourceEventId: null, sourceEventIds: [], voided: false,
    voidedBy: null, voidedAt: null, voidedReason: null,
  },
  {
    id: 'evt-2', sessionId, seq: 2, phaseId: null, ts: '2026-10-16T01:01:00.000Z',
    authorId: 'a_coder', authorKind: 'agent', kind: 'message', text: '网关已检查', mentions: [], toolCalls: [],
    replyMode: 'normal', sourceEventId: null, sourceEventIds: [], voided: false,
    voidedBy: null, voidedAt: null, voidedReason: null,
  },
  {
    id: 'evt-voided', sessionId, seq: 3, phaseId: null, ts: '2026-10-16T01:02:00.000Z',
    authorId: 'u_alice', authorKind: 'user', kind: 'message', text: '网关旧值', mentions: [], toolCalls: [],
    replyMode: 'normal', sourceEventId: null, sourceEventIds: [], voided: true,
    voidedBy: 'u_alice', voidedAt: '2026-10-16T01:03:00.000Z', voidedReason: 'retracted',
  },
  {
    id: 'evt-tool', sessionId, seq: 4, phaseId: null, ts: '2026-10-16T01:04:00.000Z',
    authorId: null, authorKind: 'system', kind: 'system', text: 'tool result: 网关', mentions: [], toolCalls: [{ id: 'tool.code.execute', args: '{}' } as any],
    replyMode: 'normal', sourceEventId: null, sourceEventIds: [], voided: false,
    voidedBy: null, voidedAt: null, voidedReason: null,
  },
]
const searchCalls: Array<{ sessionId: string; query: string }> = []
const writes: string[] = []
const ctx = Object.assign(new Context(), {
  session: {
    getSession: (id: string) => id === 's_current' ? { id, status: 'open' } : undefined,
    listMembers: (id: string, activeOnly: boolean) => id === 's_current' && activeOnly
      ? [{ principalId: 'agent.coder' }] : [],
  },
  eventLog: {
    async search(sessionId: string, query: string) {
      searchCalls.push({ sessionId, query })
      return events(sessionId).filter((event) => event.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    },
    append: async () => { writes.push('append') },
  },
}) as any
const registry = new ToolRegistry(ctx, { allow: ['tool.session.history-search'] })
ctx.tools = registry
applyHistorySearch(ctx)

const descriptor = registry.list().find((tool) => tool.id === 'tool.session.history-search')
assert.ok(descriptor, 'session history search is registered in the configurable tool catalog')
assert.match(descriptor.description ?? '', /只读/u)
assert.match(descriptor.description ?? '', /offset/u)

const firstPage = await registry.invoke('tool.session.history-search', JSON.stringify({ query: ' 网关 ', limit: 1 }), {
  id: 'agent.coder', sessionId: 's_current',
})
assert.equal(firstPage.ok, true)
assert.deepEqual(JSON.parse(firstPage.output), {
  sessionId: 's_current', query: '网关', total: 2, offset: 0, limit: 1, hasMore: true,
  items: [{ eventId: 'evt-1', authorId: 'u_alice', authorKind: 'user', timestamp: '2026-10-16T01:00:00.000Z', matchedText: '发布网关需要灰度验证' }],
})
const secondPage = await registry.invoke('tool.session.history-search', JSON.stringify({ query: '网关', limit: 1, offset: 1 }), {
  id: 'agent.coder', sessionId: 's_current',
})
assert.equal(secondPage.ok, true)
assert.deepEqual(JSON.parse(secondPage.output).items, [
  { eventId: 'evt-2', authorId: 'a_coder', authorKind: 'agent', timestamp: '2026-10-16T01:01:00.000Z', matchedText: '网关已检查' },
])
assert.equal(JSON.parse(secondPage.output).hasMore, false)
assert.deepEqual(searchCalls, [
  { sessionId: 's_current', query: '网关' }, { sessionId: 's_current', query: '网关' },
], 'search uses the caller session, never an argument-provided session')

for (const args of [
  { query: '  ' }, { query: '网关', sessionId: 's_other' }, { query: '网关', limit: 51 }, { query: '网关', offset: -1 },
]) {
  const rejected = await registry.invoke('tool.session.history-search', JSON.stringify(args), {
    id: 'agent.coder', sessionId: 's_current',
  })
  assert.equal(rejected.ok, false)
}
assert.equal(searchCalls.length, 2, 'invalid arguments never query history')
const nonMember = await registry.invoke('tool.session.history-search', JSON.stringify({ query: '网关' }), {
  id: 'agent.outsider', sessionId: 's_current',
})
assert.equal(nonMember.ok, false)
const crossSession = await registry.invoke('tool.session.history-search', JSON.stringify({ query: '网关' }), {
  id: 'agent.coder', sessionId: 's_other',
})
assert.equal(crossSession.ok, false)
assert.equal(searchCalls.length, 2, 'invalid and cross-session scopes never reach event log')
assert.deepEqual(writes, [], 'history search has no event mutation path')
console.log('✓ Current-session history search returns paginated event references and rejects invalid or cross-session reads')
