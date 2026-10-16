import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { handleInbound } from '../plugins/staging-commands/index.ts'
import { apply as applyTeamspace } from '../packages/client-ui/space-client-ui-teamspace/src/index.ts'

const ctx = Object.assign(new Context(), {
  session: { getSession: (id: string) => id === 's_empty' ? { id, status: 'open' } : undefined },
  sessionMembers: [],
  commands: { dispatch: async () => { throw new Error('chat input must not dispatch commands') } },
}) as any
let appended = 0
let plans = 0
let appendedText = ''
ctx.session.listMembers = () => []
ctx.eventLog = { append(event: { text: string }) { appended++; appendedText = event.text; return { ...event, id: 'e_test', seq: appended } } }
ctx.emit = (name: string) => { if (name === 'space/plan') plans++ }

const result = await handleInbound(ctx, 's_empty', 'u_member', ' \t\n ')
assert.deepEqual(result, { error: 'empty_text', detail: '消息文本为空' })
assert.equal(appended, 0, 'empty input does not reach event persistence')
assert.equal(plans, 0, 'empty input does not dispatch an Agent plan')

// Exercise the authenticated Teamspace RPC boundary as well as handleInbound.
let rpcMethods: Record<string, (...args: any[]) => any> = {}
const rpcCtx = Object.assign(new Context(), {
  ui: { registerPanel() {} },
  webui: { addEntry(_entry: unknown, methods: Record<string, (...args: any[]) => any>) { rpcMethods = methods } },
  users: { verifyToken: async (token: string) => token === 'token' ? { id: 'u_member', kind: 'human' } : null },
  session: {
    getSession: (id: string) => id === 's_empty' ? { id, status: 'open' } : undefined,
    listMembers: () => [{ principalId: 'u_member', role: '成员' }],
  },
  settings: { get: (_key: string, fallback: unknown) => fallback, set() {} },
  agentCatalog: { get() { throw new Error('no legacy agent definitions') } },
  eventLog: {
    append(event: { text: string }) { appended++; appendedText = event.text; return { ...event, id: 'e_rpc', seq: appended } },
    listBySession: () => [],
  },
  commands: { dispatch: async () => { throw new Error('blank input must not dispatch commands') } },
}) as any
applyTeamspace(rpcCtx)
const rpcResult = await rpcMethods.send('token', 's_empty', ' \t\n ')
assert.deepEqual(rpcResult, { error: 'empty_text', detail: '消息文本为空' }, 'Teamspace RPC rejects whitespace with an explanation')
assert.equal(appended, 0, 'whitespace RPC does not persist a timeline event')
assert.equal(plans, 0, 'whitespace RPC does not trigger an Agent plan')

const slashText = await handleInbound(ctx, 's_empty', 'u_member', '/test')
assert.deepEqual(slashText, { reply: '' }, 'slash-prefixed text is an ordinary chat message')
assert.equal(appendedText, '/test', 'slash-prefixed text reaches the event log unchanged')
assert.equal(plans, 1, 'slash-prefixed text uses the regular message plan path')
console.log('✓ Empty messages are rejected; slash-prefixed text is stored and routed as ordinary chat')
