import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { handleInbound } from '../plugins/staging-commands/index.ts'

const ctx = Object.assign(new Context(), {
  session: { getSession: (id: string) => id === 's_empty' ? { id, status: 'open' } : undefined },
  commands: { dispatch: async () => ({ text: 'unexpected command dispatch' }) },
}) as any
let appended = 0
let plans = 0
ctx.eventLog = { append() { appended++; throw new Error('empty input must not append') } }
ctx.emit = (name: string) => { if (name === 'space/plan') plans++ }

const result = await handleInbound(ctx, 's_empty', 'u_member', ' \t\n ')
assert.deepEqual(result, { error: 'empty_text', detail: '消息文本为空' })
assert.equal(appended, 0, 'empty input does not reach event persistence')
assert.equal(plans, 0, 'empty input does not dispatch an Agent plan')
console.log('✓ Empty inbound messages are rejected before event append and Agent-plan dispatch')
