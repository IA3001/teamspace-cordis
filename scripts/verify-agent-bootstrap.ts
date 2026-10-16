import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { AgentRegistry, apply as applyAgentRegistry } from '../plugins/agent-registry/index.ts'
import { SqliteAgentCatalog } from '../packages/impl/space-store-sqlite/src/agent-catalog.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'

const migrations = loadMigrations(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url).pathname)
const db = new DatabaseSync(':memory:')
try {
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of migrations) db.exec(migration.up)
  const context = Object.assign(new Context(), {}) as Context & Record<string, any>
  const catalog = new SqliteAgentCatalog(context, db)
  Object.assign(context, { agentCatalog: catalog })
  applyAgentRegistry(context)
  const expected = new Map([
    ['agent.coder', { tools: ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute', 'tool.session.todos'], speech: 'proactive' }],
    ['agent.tester', { tools: ['tool.workspace.read', 'tool.code.execute'], speech: 'proactive' }],
    ['agent.reviewer', { tools: ['tool.workspace.read'], speech: 'proactive' }],
    ['a_analyst', { tools: ['web.search'], speech: 'proactive' }],
    ['a_challenger', { tools: ['web.search'], speech: 'passive' }],
    ['a_recorder', { tools: [], speech: 'passive' }],
  ])
  for (const [id, policy] of expected) {
    const definition = catalog.get(id)
    const registered = context.agents.get(id).descriptor
    assert.equal(definition.status, 'active')
    assert.equal(registered.kind, 'custom', `${id} is a catalog Agent, not a plugin kind`)
    assert.deepEqual(registered.toolIds, policy.tools)
    assert.equal(registered.speechPolicy, policy.speech)
  }
  assert.equal(catalog.get('agent.coder').promptRef, 'prompt.coding')
  assert.equal(catalog.get('agent.tester').promptRef, 'prompt.testing')
  assert.equal(catalog.get('agent.reviewer').promptRef, 'prompt.review')
  assert.equal(catalog.get('a_analyst').promptRef, 'prompt.analysis')
  assert.equal(catalog.get('a_challenger').promptRef, 'prompt.challenge')
  assert.deepEqual(new Set(context.agents.list().map((agent: { descriptor: { id: string } }) => agent.descriptor.id)), new Set(expected.keys()))
  console.log('✓ Seeded roles share the generic catalog registry with no per-Agent plugin bootstrap')
} finally {
  db.close()
}
