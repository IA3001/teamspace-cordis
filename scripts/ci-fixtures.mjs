// Synthetic fixtures in the disposable CI checkout, never in the live database.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const cwd = process.cwd()
assert(cwd.startsWith(join(tmpdir(), 'teamspace-ci-')), 'Fixtures are restricted to disposable CI checkouts')
const db = new DatabaseSync('data/database.db')
try {
  const agents = db.prepare("SELECT * FROM agent_definitions WHERE status='active'").all()
  assert(agents.length, 'seed must provide shared Agents')
  const columns = Object.keys(agents[0])
  const insert = db.prepare(`INSERT INTO agent_definitions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
  for (let index = 0; index < 16; index++) {
    const row = { ...agents[0], id: `zz_ci_scroll_${index}`, title: `验收滚动 Agent ${index}` }
    insert.run(...columns.map((column) => row[column]))
  }
  for (const agent of agents) {
    const root = resolve('data/workdirs', agent.id.replace(/[^A-Za-z0-9._-]/g, '_'))
    for (const folder of ['notes', 'projects/ci-fixture/src', 'scripts', 'tasks']) mkdirSync(join(root, folder), { recursive: true })
    for (let index = 0; index < 25; index++) writeFileSync(join(root, `tasks/fixture-${index}.md`), `Synthetic task ${index}\n`)
  }
  console.log('✓ Synthetic overflow Agents and hierarchical workspace fixtures prepared')
} finally { db.close() }
