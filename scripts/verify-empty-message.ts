import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { handleInbound } from '../plugins/staging-commands/index.ts'

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

const slashText = await handleInbound(ctx, 's_empty', 'u_member', '/test')
assert.deepEqual(slashText, { reply: '' }, 'slash-prefixed text is an ordinary chat message')
assert.equal(appendedText, '/test', 'slash-prefixed text reaches the event log unchanged')
assert.equal(plans, 1, 'slash-prefixed text uses the regular message plan path')
console.log('✓ Empty messages are rejected; slash-prefixed text is stored and routed as ordinary chat')
