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
const profileMigration = migrations.find((m) => m.version === 27)
assert.ok(profileMigration, 'per-Agent text model profile migration must be present')
const templateMigration = migrations.find((m) => m.version === 28)
assert.ok(templateMigration, 'Agent template provenance migration must be present')
const teamTemplateMigration = migrations.find((m) => m.version === 29)
assert.ok(teamTemplateMigration, 'team-authored Agent template migration must be present')
const dir = mkdtempSync(join(tmpdir(), 'agent-catalog-verify-'))
const path = join(dir, 'catalog.db')

try {
  let db = new DatabaseSync(path)
  db.exec(migration)
  db.exec(profileMigration.up)
  db.exec(templateMigration.up)
  db.exec(teamTemplateMigration.up)
  let catalog = new SqliteAgentCatalog(new Context(), db)
  const created = catalog.create({
    title: '研究助手',
    description: '检索资料并给出依据。',
    promptRef: 'prompt.research',
    modelRef: 'model.reasoning',
    llmProfileRef: 'ark-coding',
    templateOrigin: { id: 'research', version: 1 },
    toolIds: ['web.search', 'kb.search'],
    contextSources: ['session', 'agent-memory', 'team-kb'],
    memoryPolicy: 'agent',
    speechPolicy: 'passive',
  }, 'a_shared_research')
  assert.equal(created.id, 'a_shared_research')
  assert.equal(created.status, 'active')
  assert.equal(created.llmProfileRef, 'ark-coding')
  assert.deepEqual(created.templateOrigin, { id: 'research', version: 1 })
  assert.deepEqual(created.toolIds, ['web.search', 'kb.search'])
  const teamTemplate = catalog.saveTemplate({
    title: '发布验收助手', summary: '检查发布前后状态', input: {
      title: '发布验收助手', description: '验证发布前后状态并列出结果。', promptRef: '', modelRef: '', llmProfileRef: 'ark-coding',
      toolIds: ['web.search'], contextSources: ['session', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  })
  assert.equal(teamTemplate.teamOwned, true)
  assert.equal(teamTemplate.version, 1)
  const teamTemplateV2 = catalog.saveTemplate({
    title: '发布验收助手', summary: '检查发布和回滚状态', input: { ...teamTemplate.input, description: '验证发布与回滚状态。' },
  }, teamTemplate.id)
  assert.equal(teamTemplateV2.version, 2, 'saving a shared template appends an immutable revision')
  assert.equal(catalog.hasTemplateVersion(teamTemplate.id, 1), true, 'prior versions remain addressable for Agent provenance')
  assert.equal(catalog.listTemplates().find((template) => template.id === teamTemplate.id)?.version, 2,
    'the template picker exposes the newest shared version')
  assert.throws(() => catalog.saveTemplate({ title: '', summary: '无效', input: teamTemplate.input }), /模板名称/u)
  assert.deepEqual(catalog.list().map((a) => a.id), [created.id])
  assert.throws(() => catalog.create({
    title: '研究助手', description: 'duplicate', promptRef: '', modelRef: '',
    toolIds: [], contextSources: [], memoryPolicy: 'agent', speechPolicy: 'passive',
  }), (e: unknown) => e instanceof AgentCatalogError && e.code === 'duplicate_title')

  const updated = catalog.update(created.id, { description: '检索并引用团队资料。', toolIds: ['kb.search'] })
  assert.equal(updated.description, '检索并引用团队资料。')
  assert.equal(updated.llmProfileRef, 'ark-coding', 'patches that omit the profile retain it')
  assert.deepEqual(updated.templateOrigin, { id: 'research', version: 1 }, 'editing an Agent preserves its immutable template origin')
  assert.deepEqual(updated.toolIds, ['kb.search'])

  const columns = db.prepare(`PRAGMA table_info(agent_definitions)`).all() as Array<{ name: string }>
  assert.equal(columns.some((column) => /creator|owner/i.test(column.name)), false, 'catalog must not assign personal ownership')
  db.close()

  const rollbackDb = new DatabaseSync(':memory:')
  rollbackDb.exec(migration)
  rollbackDb.exec(profileMigration.up)
  rollbackDb.exec(templateMigration.up)
  rollbackDb.exec(teamTemplateMigration.up)
  rollbackDb.exec(teamTemplateMigration.down)
  rollbackDb.exec(templateMigration.down)
  rollbackDb.exec(profileMigration.down)
  assert.equal(rollbackDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_templates'`).get(), undefined,
    'team template rollback removes the added table')
  const rolledBackColumns = rollbackDb.prepare(`PRAGMA table_info(agent_definitions)`).all() as Array<{ name: string }>
  assert.equal(rolledBackColumns.some((column) => column.name === 'llm_profile_ref'), false, 'profile migration down removes the additive column')
  assert.equal(rolledBackColumns.some((column) => column.name === 'template_id' || column.name === 'template_version'), false,
    'template provenance rollback removes both additive columns')
  rollbackDb.close()

  // Definitions survive a process/database reopen and remain globally enumerable.
  db = new DatabaseSync(path)
  catalog = new SqliteAgentCatalog(new Context(), db)
  assert.equal(catalog.get(created.id).title, '研究助手')
  assert.equal(catalog.list().length, 1)
  assert.equal(catalog.listTemplates().find((template) => template.id === teamTemplate.id)?.version, 2,
    'team-authored templates survive closing and reopening the database')
  assert.equal(catalog.archive(created.id).status, 'archived')
  assert.equal(catalog.list().length, 0)
  assert.equal(catalog.list(true).length, 1)
  db.close()

  console.log('✓ Agent catalog persistence, team-wide ownership model, update, duplicate-name guard, and archive checks passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
