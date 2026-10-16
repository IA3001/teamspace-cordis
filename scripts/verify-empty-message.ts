import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { handleInbound } from '../plugins/staging-commands/index.ts'
import { MESSAGE_TEXT_LIMIT, messageLengthNotice } from '../packages/client-ui/space-client-ui-teamspace/client/message-validation.ts'

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

const atLimit = 'a'.repeat(MESSAGE_TEXT_LIMIT)
const atLimitResult = await handleInbound(ctx, 's_empty', 'u_member', atLimit)
assert.deepEqual(atLimitResult, { reply: '' }, '5000 characters remain sendable')
assert.equal(appendedText, atLimit, 'the maximum allowed message reaches the event log unchanged')
assert.equal(messageLengthNotice(atLimit), null, 'the composer does not warn at the allowed boundary')

const appendedBeforeRejection = appended
const overLimit = 'a'.repeat(MESSAGE_TEXT_LIMIT + 1)
const overLimitResult = await handleInbound(ctx, 's_empty', 'u_member', overLimit)
assert.deepEqual(overLimitResult, {
  error: 'text_too_long',
  detail: '消息过长（5001 字符，上限 5000）—— 长内容请走文件消息',
}, '5001 characters are rejected with the server attachment guidance')
assert.equal(appended, appendedBeforeRejection, 'an over-limit message is not persisted')
assert.equal(messageLengthNotice(overLimit), '消息超过 5000 字符，请使用文件附件发送长内容。',
  'the composer gives visible attachment guidance above the allowed boundary')
console.log('✓ Empty and over-limit messages are rejected with guidance; 5000 characters remain sendable')
