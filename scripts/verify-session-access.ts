import assert from 'node:assert/strict'
import { apply } from '../plugins/space-push/index.ts'
import { apply as applyReadApi } from '../plugins/space-api/index.ts'

type Listener = (...args: any[]) => unknown
const listeners = new Map<string, Listener[]>()
const sent = new Map<string, unknown[]>()
const identities = new Map<string, { id: string; kind: string }>([
  ['token-a', { id: 'u_a', kind: 'human' }],
  ['token-b', { id: 'u_b', kind: 'human' }],
])
const clients = Object.fromEntries(['client-a', 'client-b'].map((id) => [id, {
  id,
  socket: { addEventListener() {} },
  send(payload: unknown) { sent.get(id)!.push(payload) },
}]))
for (const id of Object.keys(clients)) sent.set(id, [])

const rpcHandler = async function (this: { id: string }) { sent.get(this.id)!.push('rpc-called') }
const ctx = {
  webui: { clients, listeners: { 'rpc:request': rpcHandler } },
  users: { async verifyToken(token: string) { const user = identities.get(token); if (!user) throw new Error('unauthorized'); return user } },
  session: {
    listMembers(sessionId: string) {
      return sessionId === 's-a' ? [{ principalId: 'u_a' }] : [{ principalId: 'u_b' }]
    },
    listSessions() { return [{ id: 's-a' }, { id: 's-b' }] },
  },
  sessionWork: { state: () => ({
    activeSessionId: 's-a', owners: ['agent.a'],
    queue: [{ sessionId: 's-a', owner: 'agent.a', position: 1 }, { sessionId: 's-b', owner: 'agent.b', position: 2 }],
  }) },
  on(name: string, listener: Listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
  effect() {},
} as never

apply(ctx)
const dispatch = async (name: string, payload: unknown) => {
  await Promise.all((listeners.get(name) ?? []).map((listener) => listener(payload)))
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

for (const id of Object.keys(clients)) {
  await (ctx as any).webui.listeners['rpc:request'].call(clients[id], { args: [id === 'client-a' ? 'token-a' : 'token-b'] })
}
await dispatch('space/event-appended', { event: { sessionId: 's-a', id: 'event-secret', seq: 7, text: 'private message body' } })
await dispatch('space/agent-progress', { sessionId: 's-a', runId: 'run-a', phase: 'text-delta', delta: 'private live answer' })
await dispatch('session-work/changed', (ctx as any).sessionWork.state())
await flush()

const memberFrames = sent.get('client-a')!
const nonMemberFrames = sent.get('client-b')!
assert.ok(memberFrames.some((frame: any) => frame.type === 'space:event' && frame.body.eventId === 'event-secret'))
assert.ok(memberFrames.some((frame: any) => frame.type === 'space:agent-progress' && frame.body.delta === 'private live answer'))
assert.ok(!nonMemberFrames.some((frame: any) => typeof frame === 'object' && JSON.stringify(frame).includes('private')),
  'session event text and Agent token deltas are never broadcast to non-members')
const memberWork = memberFrames.find((frame: any) => frame.type === 'space:session-work') as any
const outsiderWork = nonMemberFrames.find((frame: any) => frame.type === 'space:session-work') as any
assert.deepEqual(memberWork.body.queue.map((item: any) => item.sessionId), ['s-a'])
assert.equal(outsiderWork.body.activeSessionId, null)
assert.deepEqual(outsiderWork.body.queue.map((item: any) => item.sessionId), ['s-b'])

const routes = new Map<string, (req: any) => Promise<Response>>()
const readApiCtx = {
  server: { get(path: string, handler: (req: any) => Promise<Response>) { routes.set(path, handler) } },
  session: {
    listSessions: () => [{ id: 's-a' }, { id: 's-b' }],
    getSession: (id: string) => ({ id }),
    listMembers: (id: string) => id === 's-a' ? [{ principalId: 'u_a' }] : [{ principalId: 'u_b' }],
  },
  eventLog: { listBySession: (id: string) => [{ id: `event-${id}`, text: 'private history' }] },
  ui: { listPanels: () => [] },
  users: {
    verifyToken: async (token: string) => {
      const user = identities.get(token)
      if (!user) throw new Error('unauthorized')
      return user
    },
    listHumans: async () => [{ id: 'u_a' }, { id: 'u_b' }],
  },
} as never
applyReadApi(readApiCtx)
const request = (token: string, params: Record<string, string> = {}) => ({
  headers: { get: (name: string) => name === 'authorization' ? `Bearer ${token}` : null }, params,
})
const listed = await routes.get('/api/sessions')!(request('token-a'))
assert.deepEqual((await listed.json() as Array<{ id: string }>).map((session) => session.id), ['s-a'])
const privateHistory = await routes.get('/api/sessions/:id/events')!(request('token-b', { id: 's-a' }))
assert.equal(privateHistory.status, 404)
assert.doesNotMatch(await privateHistory.text(), /private history/)
const memberHistory = await routes.get('/api/sessions/:id/events')!(request('token-a', { id: 's-a' }))
assert.match(await memberHistory.text(), /private history/)
const unauthenticatedUsers = await routes.get('/api/users')!(request('bad-token'))
assert.equal(unauthenticatedUsers.status, 401)
console.log('✓ WebSocket event pointers, Agent progress, typing, and queue state are scoped to authenticated session members')
