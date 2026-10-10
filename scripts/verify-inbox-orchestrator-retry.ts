import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentInbox } from '../plugins/agent-inbox/index.ts'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'

// Exercises real Inbox retry/backoff against a separate OS process restoring a
// durable Orchestrator Plan. Everything uses an isolated temporary SQLite DB.
const dir = mkdtempSync(join(tmpdir(), 'teamspace-inbox-orchestrator-retry-'))
const dbPath = join(dir, 'shared.db')
const signals = join(dir, 'signals')
mkdirSync(signals)
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')
const migrations = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrations)) db.exec(migration.up)
const now = new Date().toISOString()
for (const [id, username, name, kind] of [
  ['u_retry_dri', 'retry_dri', 'DRI', 'human'],
  ['a_retry_worker', 'retry_worker', '研究员', 'agent'],
  ['a_engine_race', 'retry_coordinator', '协调者', 'agent'],
]) {
  db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, ?, ?, 'member')`).run(id, username, name, kind, now)
}
for (const [id, title] of [['s_retry', 'Inbox 重试'], ['s_engine_race', '持久恢复'], ['s_blocker', '初始阻塞']]) {
  db.prepare(`INSERT INTO sessions(id, title, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)`)
    .run(id, title, now, now)
}
db.prepare(`INSERT INTO session_members(session_id, principal_id, role, status, joined_at) VALUES
  ('s_retry', 'u_retry_dri', 'DRI', 'active', ?),
  ('s_retry', 'a_retry_worker', '成员', 'active', ?),
  ('s_engine_race', 'u_retry_dri', 'DRI', 'active', ?),
  ('s_engine_race', 'a_engine_race', '协调者', 'active', ?)`)
  .run(now, now, now, now)

const seed = new Context() as Context & Record<string, any>
new SqliteSessionStore(seed, db)
const eventLog = new SqliteEventLog(seed, db)
new SqliteSettingsStore(seed, db)
const planEvent = eventLog.append({
  id: 'event_retry_plan', sessionId: 's_engine_race', authorId: 'u_retry_dri', phaseId: null,
  authorKind: 'human', kind: 'message', text: '恢复持久计划', mentions: [], toolCalls: [], replyMode: '',
})
seed.settings.set('orchestrator.runtime.v1', {
  version: 1,
  turns: [['s_engine_race', { state: 'chain', decisionCalls: 0, autonomousActions: 0,
    delegatedTargets: [], stopReason: '', stopDetail: '' }]],
  delegations: [], queue: [],
  activeDecisions: [{ payload: { sessionId: 's_engine_race', authorId: 'u_retry_dri', event: planEvent }, resetTurn: true }],
})
eventLog.append({
  id: 'event_retry_message', sessionId: 's_retry', authorId: 'u_retry_dri', phaseId: null,
  authorKind: 'human', kind: 'message', text: '请记录稳定结论。', mentions: [], toolCalls: [], replyMode: '',
})
db.close()

const parentDb = new DatabaseSync(dbPath)
parentDb.exec('PRAGMA busy_timeout = 5000')
const ctx = new Context() as Context & Record<string, any>
const work = new SqliteSessionWork(ctx, parentDb, { processId: 'retry-inbox', heartbeatMs: 15 })
new SqliteSessionStore(ctx, parentDb)
new SqliteEventLog(ctx, parentDb)
const memory = new SqliteMemoryStore(ctx, parentDb)
const agents = new AgentRegistry(ctx)
agents.register({ id: 'a_retry_worker', kind: 'custom', title: '研究员', capabilities: [] })
let attempts = 0
Object.assign(ctx, {
  logger: { error() {}, warn() {}, info() {} },
  llm: {
    configured: true,
    configuredFor: () => true,
    async chat() {
      attempts++
      writeFileSync(join(signals, `inbox-attempt-${attempts}`), 'attempt')
      if (attempts === 1) throw new Error('simulated transient model failure')
      return JSON.stringify({ memories: [{ text: '持久结论已记录', weight: 0.9 }] })
    },
  },
})
new AgentInbox(ctx)
let child: ReturnType<typeof spawn> | undefined

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert(predicate(), `timed out waiting for ${label}`)
}

try {
  assert.equal(work.tryEnter('s_blocker', 'test-blocker'), true)
  const inbox = ctx.agentInbox as AgentInbox
  const event = ctx.eventLog.listBySession('s_retry')[0]!
  const firstWait = inbox.waitThrough('a_retry_worker', 's_retry', event.seq).catch(() => undefined)
  await waitFor(() => Number((parentDb.prepare(`SELECT count(*) AS n FROM session_work_queue
    WHERE session_id = 's_retry' AND owner = 'agent-inbox'`).get() as { n: number }).n) === 1, 'Inbox durable queue entry')

  child = spawn(process.execPath, [
    '--import', 'tsx', 'scripts/orchestrator-recovery-race-worker.ts', dbPath, 'orchestrator-restore', signals,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
  const closed = new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject)
    child!.once('close', resolve)
  })
  await waitFor(() => existsSync(join(signals, 'orchestrator-restore.ready')), 'recovery worker readiness')
  writeFileSync(join(signals, 'begin'), 'start')
  await waitFor(() => existsSync(join(signals, 'orchestrator-restore.waiting-for-shared-slot')),
    'recovery worker to observe the active Inbox blocker')
  work.leave('s_blocker', 'test-blocker')

  await waitFor(() => existsSync(join(signals, 'inbox-attempt-1')), 'first Inbox extraction attempt')
  await waitFor(() => existsSync(join(signals, 'orchestrator-restore.brain-started')),
    'durable Orchestrator recovery during Inbox backoff')
  assert.equal(attempts, 1, 'failed Inbox attempt remains pending during its retry delay')
  writeFileSync(join(signals, 'orchestrator-restore.release'), 'release')
  const code = await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`recovery worker timeout: ${output}\n${errors}`)), 15_000)),
  ])
  assert.equal(code, 0, `recovery worker failed: ${errors || output}`)

  await firstWait
  await waitFor(() => attempts >= 2, 'Inbox retry after Orchestrator completion', 8_000)
  await waitFor(() => existsSync(join(signals, 'orchestrator-restore.brain-started')) &&
    parentDb.prepare(`SELECT count(*) AS n FROM events WHERE session_id = 's_engine_race'
      AND author_id = 'a_engine_race' AND source_event_id = 'event_retry_plan'`).get().n === 1,
  'one persisted Orchestrator reply')
  await waitFor(() => Number((parentDb.prepare(`SELECT count(*) AS n FROM memories
    WHERE scope = 'agent:a_retry_worker' AND source_event_id = 'event_retry_message'`).get() as { n: number }).n) === 1,
  'durable Inbox memory after retry')
  assert.equal(await inbox.cursor('a_retry_worker', 's_retry'), event.seq,
    'Inbox advances its cursor only after the retry persists memory')
  assert.equal(work.state().activeSessionId, null, 'both workflows release the global session slot')
  console.log('✓ Real Inbox failure backoff yields to cross-process Orchestrator recovery, then retries and persists memory')
} finally {
  if (child?.exitCode === null) child.kill('SIGKILL')
  work.dispose()
  parentDb.close()
  rmSync(dir, { recursive: true, force: true })
}
