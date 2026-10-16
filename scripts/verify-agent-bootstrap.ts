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
    ['agent.coder', { tools: ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute', 'tool.workspace.verify', 'tool.workspace.run-cpp', 'tool.workspace.publish'], speech: 'proactive' }],
    ['agent.tester', { tools: ['tool.workspace.read', 'tool.code.execute', 'tool.workspace.verify', 'tool.workspace.run-cpp'], speech: 'proactive' }],
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
  const migration = migrations.find((item) => item.version === 37)
  assert.ok(migration, 'workspace completeness migration must be present')
  const upgradeDb = new DatabaseSync(':memory:')
  try {
    upgradeDb.exec('PRAGMA foreign_keys = ON')
    for (const item of migrations.filter((entry) => entry.version < 37)) upgradeDb.exec(item.up)
    upgradeDb.prepare('UPDATE agent_definitions SET tool_ids=? WHERE id=?').run('["custom.tool","tool.workspace.read"]', 'agent.coder')
    upgradeDb.prepare('UPDATE agent_definitions SET tool_ids=? WHERE id=?').run('["tool.workspace.verify"]', 'agent.tester')
    upgradeDb.exec(migration.up)
    assert.deepEqual(JSON.parse(String(upgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.coder')?.tool_ids)),
      ['custom.tool', 'tool.workspace.read', 'tool.workspace.verify'], 'upgrade preserves custom tools while adding project verification')
    assert.deepEqual(JSON.parse(String(upgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.tester')?.tool_ids)),
      ['tool.workspace.verify'], 'upgrade does not duplicate the verifier when it is already configured')
    upgradeDb.exec(migration.down)
    assert.deepEqual(JSON.parse(String(upgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.coder')?.tool_ids)),
      ['custom.tool', 'tool.workspace.read', 'tool.workspace.verify'], 'rollback preserves team configuration')
  } finally { upgradeDb.close() }
  const cppMigration = migrations.find((item) => item.version === 38)
  assert.ok(cppMigration, 'controlled C++ runner migration must be present')
  const cppUpgradeDb = new DatabaseSync(':memory:')
  try {
    cppUpgradeDb.exec('PRAGMA foreign_keys = ON')
    for (const item of migrations.filter((entry) => entry.version < 38)) cppUpgradeDb.exec(item.up)
    cppUpgradeDb.prepare('UPDATE agent_definitions SET tool_ids=? WHERE id=?').run('[]', 'agent.coder')
    cppUpgradeDb.prepare('UPDATE agent_definitions SET tool_ids=? WHERE id=?').run('["custom.tool","tool.workspace.verify"]', 'agent.tester')
    cppUpgradeDb.exec(cppMigration.up)
    assert.deepEqual(JSON.parse(String(cppUpgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.coder')?.tool_ids)),
      ['tool.workspace.run-cpp'], 'upgrade adds the controlled runner to a customized Agent')
    assert.deepEqual(JSON.parse(String(cppUpgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.tester')?.tool_ids)),
      ['custom.tool', 'tool.workspace.verify', 'tool.workspace.run-cpp'], 'upgrade preserves existing tools and adds the runner once')
    cppUpgradeDb.exec(cppMigration.up)
    assert.deepEqual(JSON.parse(String(cppUpgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.tester')?.tool_ids)),
      ['custom.tool', 'tool.workspace.verify', 'tool.workspace.run-cpp'], 'upgrade is safe to retry without duplicate tools')
    cppUpgradeDb.exec(cppMigration.down)
    assert.deepEqual(JSON.parse(String(cppUpgradeDb.prepare('SELECT tool_ids FROM agent_definitions WHERE id=?').get('agent.tester')?.tool_ids)),
      ['custom.tool', 'tool.workspace.verify', 'tool.workspace.run-cpp'], 'rollback preserves team tool configuration')
  } finally { cppUpgradeDb.close() }
  console.log('✓ Seeded roles share the generic catalog registry with no per-Agent plugin bootstrap')
} finally {
  db.close()
}
