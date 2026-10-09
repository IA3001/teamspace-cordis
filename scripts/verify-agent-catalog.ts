// Focused persistence checks for team-shared, data-driven Agent definitions.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from 'cordis'
import { AgentCatalogError } from 'space-agent-catalog'
import { SqliteAgentCatalog } from '../packages/impl/space-store-sqlite/src/agent-catalog.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'

const root = resolve(import.meta.dirname ?? '.', '..')
const migrationsDir = join(root, 'packages/impl/space-store-sqlite/migrations')
const migrations = loadMigrations(migrationsDir)
assert.equal(migrations.find((m) => m.name === 'agent_catalog')?.version, 14)
const migration = readFileSync(join(migrationsDir, '0014_agent_catalog.up.sql'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'agent-catalog-verify-'))
const path = join(dir, 'catalog.db')

try {
  let db = new DatabaseSync(path)
  db.exec(migration)
  let catalog = new SqliteAgentCatalog(new Context(), db)
  const created = catalog.create({
    title: '研究助手',
    description: '检索资料并给出依据。',
    promptRef: 'prompt.research',
    modelRef: 'model.reasoning',
    toolIds: ['web.search', 'kb.search'],
    contextSources: ['session', 'agent-memory', 'team-kb'],
    memoryPolicy: 'agent',
    speechPolicy: 'passive',
  }, 'a_shared_research')
  assert.equal(created.id, 'a_shared_research')
  assert.equal(created.status, 'active')
  assert.deepEqual(created.toolIds, ['web.search', 'kb.search'])
  assert.deepEqual(catalog.list().map((a) => a.id), [created.id])
  assert.throws(() => catalog.create({
    title: '研究助手', description: 'duplicate', promptRef: '', modelRef: '',
    toolIds: [], contextSources: [], memoryPolicy: 'agent', speechPolicy: 'passive',
  }), (e: unknown) => e instanceof AgentCatalogError && e.code === 'duplicate_title')

  const updated = catalog.update(created.id, { description: '检索并引用团队资料。', toolIds: ['kb.search'] })
  assert.equal(updated.description, '检索并引用团队资料。')
  assert.deepEqual(updated.toolIds, ['kb.search'])

  const columns = db.prepare(`PRAGMA table_info(agent_definitions)`).all() as Array<{ name: string }>
  assert.equal(columns.some((column) => /creator|owner/i.test(column.name)), false, 'catalog must not assign personal ownership')
  db.close()

  // Definitions survive a process/database reopen and remain globally enumerable.
  db = new DatabaseSync(path)
  catalog = new SqliteAgentCatalog(new Context(), db)
  assert.equal(catalog.get(created.id).title, '研究助手')
  assert.equal(catalog.list().length, 1)
  assert.equal(catalog.archive(created.id).status, 'archived')
  assert.equal(catalog.list().length, 0)
  assert.equal(catalog.list(true).length, 1)
  db.close()

  console.log('✓ Agent catalog persistence, team-wide ownership model, update, duplicate-name guard, and archive checks passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
