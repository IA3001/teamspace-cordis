import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../plugins/space-tool/index.ts'
import { apply as applySessionTodos } from '../plugins/tool-session-todos/index.ts'

const calls: Array<{ scope: string; options: unknown }> = []
const writes: string[] = []
const ctx = Object.assign(new Context(), {
  session: {
    getSession: (id: string) => id === 's_allowed' ? { id, status: 'open' } : undefined,
    listMembers: (id: string, activeOnly: boolean) => id === 's_allowed' && activeOnly
      ? [{ principalId: 'agent.coder' }] : [],
  },
  memory: {
    async recall(scope: string, options: unknown) {
      calls.push({ scope, options })
      return [
        { id: 'todo_pending', text: JSON.stringify({ done: false, text: '检查验收结果' }), createdAt: '2026-10-16T00:00:00.000Z' },
        { id: 'todo_done', text: JSON.stringify({ done: true, text: '补充测试' }), createdAt: '2026-10-16T00:01:00.000Z' },
        { id: 'bad_payload', text: 'not-json', createdAt: '2026-10-16T00:02:00.000Z' },
      ]
    },
    remember: async () => { writes.push('remember') },
    forget: async () => { writes.push('forget') },
  },
}) as any
const registry = new ToolRegistry(ctx, { allow: ['tool.session.todos'] })
ctx.tools = registry
applySessionTodos(ctx)

const descriptor = registry.list().find((tool) => tool.id === 'tool.session.todos')
assert.ok(descriptor, 'session todo tool is registered in the shared tool catalog')
assert.match(descriptor.description ?? '', /只读/u)
const result = await registry.invoke('tool.session.todos', '{"action":"list"}', {
  id: 'agent.coder', sessionId: 's_allowed',
})
assert.equal(result.ok, true)
assert.deepEqual(JSON.parse(result.output), {
  sessionId: 's_allowed', count: 2,
  items: [
    { id: 'todo_pending', status: 'pending', text: '检查验收结果', createdAt: '2026-10-16T00:00:00.000Z' },
    { id: 'todo_done', status: 'completed', text: '补充测试', createdAt: '2026-10-16T00:01:00.000Z' },
  ],
})
assert.deepEqual(calls, [{ scope: 'session:s_allowed', options: { kind: 'todo', limit: 50 } }],
  'only the current session todo scope is read')

for (const action of ['create', 'complete', 'delete']) {
  const denied = await registry.invoke('tool.session.todos', JSON.stringify({ action, text: 'forbidden' }), {
    id: 'agent.coder', sessionId: 's_allowed',
  })
  assert.equal(denied.ok, false)
  assert.match(denied.output, /只读工具/u)
}
const outsideSession = await registry.invoke('tool.session.todos', '{}', { id: 'agent.coder', sessionId: 's_other' })
assert.equal(outsideSession.ok, false)
assert.equal(calls.length, 1, 'invalid session scope does not read memory')
const nonMember = await registry.invoke('tool.session.todos', '{}', { id: 'agent.outsider', sessionId: 's_allowed' })
assert.equal(nonMember.ok, false)
assert.equal(calls.length, 1, 'non-member caller does not read memory')
assert.deepEqual(writes, [], 'tool has no todo mutation side effects')
console.log('✓ Current-session todo tool returns scoped IDs/status and rejects all mutations and unauthorized scopes')
