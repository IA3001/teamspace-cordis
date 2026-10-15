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
  const insertMemory = db.prepare(`INSERT OR REPLACE INTO memories (id, scope, kind, text, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
  const longMemory = `记忆详情长文本换行验收：${'这是一段连续内容，用来确认正文会自然折行并且来源信息仍可查看。'.repeat(120)}\n记忆来源和移动操作应与正文处在同一抽屉内部滚动区域。`
  for (const agent of agents) insertMemory.run(`ui-verify-memory-detail-${agent.id}`, `agent:${agent.id}`, 'ui_verify_long_text', longMemory, 0.8, new Date().toISOString())
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
