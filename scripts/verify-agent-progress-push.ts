import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { apply as applySpacePush } from '../plugins/space-push/index.ts'
import {
  settlesPendingReply, shouldWarnAboutSocketSilence, SOCKET_SILENCE_WARNING_MS,
} from '../packages/client-ui/space-client-ui-teamspace/client/progress.ts'

assert.equal(settlesPendingReply({ authorKind: 'agent', sourceEventId: 'event-a' }), true,
  'an Agent result settles its matching pending reply')
assert.equal(settlesPendingReply({ authorKind: 'system', kind: 'system', sourceEventId: 'event-a' }), true,
  'a linked pause/error notice settles the pending reply')
assert.equal(settlesPendingReply({ authorKind: 'system', kind: 'system' }), false,
  'unrelated system activity does not settle a pending reply')
assert.equal(settlesPendingReply({ authorKind: 'human', kind: 'message', sourceEventId: 'event-a' }), false,
  'human messages do not settle a pending Agent reply')
const socketHealth = {
  now: SOCKET_SILENCE_WARNING_MS,
  lastActivityAt: 0,
  hasAgentWork: true,
  pageVisible: true,
  socketOpen: true,
  state: 'online',
}
assert.equal(shouldWarnAboutSocketSilence({ ...socketHealth, now: SOCKET_SILENCE_WARNING_MS - 1 }), false,
  'socket silence below the warning threshold stays quiet')
assert.equal(shouldWarnAboutSocketSilence(socketHealth), true,
  'visible in-flight work warns when an open socket stops delivering heartbeats')
assert.equal(shouldWarnAboutSocketSilence({ ...socketHealth, hasAgentWork: false }), false,
  'an idle conversation is not interrupted by socket silence')
assert.equal(shouldWarnAboutSocketSilence({ ...socketHealth, pageVisible: false }), false,
  'background tabs do not report a false network stall')
assert.equal(shouldWarnAboutSocketSilence({ ...socketHealth, state: 'disconnected' }), false,
  'a closed socket uses the disconnected state instead')

type Sent = { type: string; body: any }
const sent = new Map<string, Sent[]>()
const socketListeners = new Map<string, Record<string, () => void>>()
const snapshots = [{
  runId: 'run-live', sessionId: 'session-a', agentId: 'agent-a', title: '编码者',
  sourceEventId: 'event-a', phase: 'processing' as const, at: new Date().toISOString(),
  steps: [{ label: '处理任务与上下文', at: new Date().toISOString() }],
  streamText: '部分回复', streamCharacterCount: 4, streamTruncated: false,
}]
const clients = Object.fromEntries(['member', 'outsider'].map((id) => [id, {
  id,
  send(frame: Sent) { sent.set(id, [...(sent.get(id) ?? []), frame]) },
}]))
let originalRpcCalls = 0
const ctx = Object.assign(new Context(), {
  webui: {
    clients,
    listeners: {
      'rpc:request': async function (this: { id: string }) { originalRpcCalls++; return this.id },
    },
  },
  sessionWork: { state: () => ({ activeSessionId: null, owners: [], queue: [] }) },
  users: {
    async verifyToken(token: string) {
      if (token === 'member-token') return { kind: 'human', id: 'user-a' }
      if (token === 'outsider-token') return { kind: 'human', id: 'user-b' }
      throw new Error('invalid token')
    },
  },
  session: {
    listMembers(sessionId: string) { return sessionId === 'session-a' ? [{ principalId: 'user-a' }] : [] },
    listSessions() { return [{ id: 'session-a' }] },
  },
  agentRuntime: { listActiveProgress: () => snapshots },
}) as unknown as Context

applySpacePush(ctx)
const request = ctx.webui.listeners['rpc:request'] as unknown as (this: { id: string }, body: { args: string[] }) => Promise<unknown>
assert.equal(await request.call({ id: 'member' }, { args: ['member-token'] }), 'member')
assert.equal(await request.call({ id: 'outsider' }, { args: ['outsider-token'] }), 'outsider')
assert.equal(sent.get('member')?.filter((frame) => frame.type === 'space:agent-progress-snapshot').length, 1)
assert.equal(sent.get('outsider')?.filter((frame) => frame.type === 'space:agent-progress-snapshot').length ?? 0, 0)
assert.equal(originalRpcCalls, 2)

const connectionListeners: Record<string, () => void> = {}
ctx.emit('webui/connection', {
  id: 'member',
  socket: { addEventListener(name: string, listener: () => void) { connectionListeners[name] = listener } },
} as never)
connectionListeners.close?.()
await request.call({ id: 'member' }, { args: ['member-token'] })
assert.equal(sent.get('member')?.filter((frame) => frame.type === 'space:agent-progress-snapshot').length, 2)

const heartbeatAt = new Date(Date.now() + 1000).toISOString()
ctx.emit('space/agent-progress', {
  runId: 'run-live', sessionId: 'session-a', agentId: 'agent-a', title: '编码者',
  sourceEventId: 'event-a', phase: 'waiting-model', at: heartbeatAt,
})
await new Promise((resolve) => setTimeout(resolve, 20))
const forwardedHeartbeat = [...(sent.get('member') ?? [])].reverse().find((frame) =>
  frame.type === 'space:agent-progress' && frame.body?.phase === 'waiting-model')
assert.equal(forwardedHeartbeat?.body.at, heartbeatAt, 'same-phase liveness updates should reach session members')
assert.equal((sent.get('outsider') ?? []).some((frame) => frame.type === 'space:agent-progress'), false,
  'progress heartbeats must stay inside active session membership')

const progress = (delta: string) => ctx.emit('space/agent-progress', {
  runId: 'run-live', sessionId: 'session-a', agentId: 'agent-a', title: '编码者',
  sourceEventId: 'event-a', phase: 'text-delta', delta, at: new Date().toISOString(),
})
progress('请')
progress('求')
progress('解答')
await new Promise((resolve) => setTimeout(resolve, 150))
const frames = (sent.get('member') ?? []).filter((frame) => frame.type === 'space:agent-progress' && frame.body?.phase === 'text-delta')
assert.equal(frames.length, 1, 'token deltas within the coalescing window should share one socket frame')
assert.equal(frames[0]?.body.delta, '请求解答')
console.log('Agent progress reconnect snapshot, membership filtering, and delta coalescing: GREEN')
