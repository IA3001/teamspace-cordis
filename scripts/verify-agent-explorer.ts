import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agent-explorer-'))
const db = new DatabaseSync(':memory:')
const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrationsDir)) db.exec(migration.up)

try {
  const ctx = new Context()
  const agents = new AgentRegistry(ctx)
  agents.register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  agents.register({ id: 'agent.legacy', kind: 'coding', title: '旧工作区', capabilities: ['coding'] })
  const memory = new SqliteMemoryStore(ctx, db)
  const a = await memory.remember('agent:agent.coder', 'fact', '团队统一使用 Markdown 记录决策。', { weight: 0.8 })
  await memory.remember('agent:agent.coder', 'preference', '保留精简的执行记录。', { weight: 0.6 })
  assert.equal(a.folderPath, '其他', 'new memory records are assigned a default folder')
  await memory.remember('agent:agent.coder', 'cursor:session-a', '12', { weight: 1 })
  await memory.remember('agent:agent.other', 'fact', '隔离到其他 Agent 的内容。')
  db.prepare('UPDATE memories SET invalidated_at = ? WHERE id = ?').run(new Date().toISOString(), a.id)
  const current = await memory.list('agent:agent.coder', { limit: 1 })
  assert.equal(current.total, 2, 'default memory listing omits invalidated history')
  assert.equal(current.items.length, 1)
  const history = await memory.list('agent:agent.coder', { offset: 0, limit: 10, includeInvalidated: true })
  assert.equal(history.total, 3, 'explorer can include invalidated records')
  assert.equal(history.items.some((item) => item.invalidatedAt), true)
  assert.equal((await memory.list('agent:agent.coder', { offset: 100, limit: 1 })).items.length, 0)
  const visible = await memory.list('agent:agent.coder', { includeInvalidated: true, excludeSystem: true })
  assert.equal(visible.total, 2, 'internal cursor metadata stays out of the human explorer')
  const folder = await memory.createFolder('agent:agent.coder', 'Project X')
  const nestedFolder = await memory.createFolder('agent:agent.coder', '模块 A', folder.path)
  const nested = await memory.remember('agent:agent.coder', 'fact', 'A project-specific memory.', { folderPath: nestedFolder.path })
  assert.equal((await memory.list('agent:agent.coder', { folderPath: nestedFolder.path })).items[0]?.id, nested.id,
    'memory items can be listed from a nested folder')
  assert.equal((await memory.listFolders('agent:agent.coder')).some((item) => item.path === nestedFolder.path && item.itemCount === 1), true)
  await memory.move('agent:agent.coder', nested.id, '其他')
  assert.equal((await memory.list('agent:agent.coder', { folderPath: '其他' })).items.some((item) => item.id === nested.id), true,
    'moving a memory updates its explorer folder')
  await assert.rejects(memory.move('agent:agent.other', nested.id, '其他'), /不属于当前 scope/)
  console.log('✓ Agent memory folders, pagination, scope isolation, and invalidation visibility')

  const workdir = new LocalWorkdirService(ctx, tmp)
  mkdirSync(join(tmp, 'workdirs', 'agent.legacy'), { recursive: true })
  writeFileSync(join(tmp, 'workdirs', 'agent.legacy', 'artifact-old.md'), 'legacy output')
  const legacyLayout = await workdir.browse('agent.legacy')
  assert.equal(['projects', 'tasks', 'scripts', 'notes'].every((name) => legacyLayout.entries.some((entry) => entry.name === name)), true,
    'existing Agent workspaces gain the standard folders without moving legacy files')
  const handle = await workdir.claim('agent.coder')
  for (const directory of ['projects', 'tasks', 'scripts', 'notes']) {
    assert.equal((await workdir.browse('agent.coder')).entries.some((entry) => entry.name === directory), true,
      `new Agent workspaces expose the standard ${directory}/ folder`)
  }
  mkdirSync(join(handle.root, 'src'))
  writeFileSync(join(handle.root, 'src', 'answer.md'), 'Authorization: Bearer abcdefghijklmnop\napiKey=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  writeFileSync(join(handle.root, '.env'), 'API_KEY=must-not-appear')
  const outside = join(tmp, 'outside.txt')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(handle.root, 'external-link'))
  const listing = await workdir.browse('agent.coder')
  assert.equal(listing.exists, true)
  assert.equal(listing.entries.some((entry) => entry.name === '.env'), false, 'credential files are hidden')
  assert.equal(listing.entries.some((entry) => entry.name === 'external-link'), false, 'symlinks are excluded')
  const preview = await workdir.readText('agent.coder', 'src/answer.md')
  assert.match(preview, /Bearer \[REDACTED\]/i)
  assert.match(preview, /apiKey=\[REDACTED\]/i)
  await assert.rejects(workdir.browse('agent.coder', '../outside'), /越出工作区边界/)
  await assert.rejects(workdir.readText('agent.coder', 'external-link'), /符号链接/)
  console.log('✓ Workspace explorer bounds paths, hides secrets, skips links, and redacts previews')

  mkdirSync(join(tmp, 'shared-workspace', 'projects'), { recursive: true })
  writeFileSync(join(tmp, 'shared-workspace', 'projects', 'brief.md'), '共享材料\napiKey=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  const shared = await workdir.browseShared()
  assert.equal(shared.entries.some((entry) => entry.name === 'projects' && entry.kind === 'directory'), true)
  assert.match(await workdir.readSharedText('projects/brief.md'), /apiKey=\[REDACTED\]/)
  await assert.rejects(workdir.browseShared('../outside'), /越出工作区边界/)
  console.log('✓ Team shared workspace explorer is independently browsable and read-only safe')
} finally {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
}
