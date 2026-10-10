import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { AgentInbox } from '../plugins/agent-inbox/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'

const dir = mkdtempSync(join(tmpdir(), 'teamspace-inbox-orchestrator-mix-'))
const dbPath = join(dir, 'shared.db')
const signalDir = join(dir, 'signals')
mkdirSync(signalDir)
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')
for (const migration of loadMigrations(fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url)))) {
  db.exec(migration.up)
}

const seed = new Context() as Context & Record<string, any>
new SqliteSessionStore(seed, db)
const eventLog = new SqliteEventLog(seed, db)
const memory = new SqliteMemoryStore(seed, db)
for (const [id, username, displayName, kind] of [
  ['u_mixed_dri', 'mix_dri', 'DRI', 'human'],
  ['a_mixed_worker', 'mix_agent', '研究员', 'agent'],
  ['a_mixed_coordinator', 'mix_coordinator', '协调者', 'agent'],
]) {
  db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, ?, ?, 'member')`).run(id, username, displayName, kind, new Date().toISOString())
}
seed.session.createSession({ id: 's_mixed', title: '跨进程 Inbox 与 Orchestrator 混合验收' })
seed.session.join({ sessionId: 's_mixed', principalId: 'u_mixed_dri', role: 'DRI' })
seed.session.join({ sessionId: 's_mixed', principalId: 'a_mixed_worker', role: '成员' })
seed.session.join({ sessionId: 's_mixed', principalId: 'a_mixed_coordinator', role: '协调者' })
const event = eventLog.append({
  id: 'event_mixed', sessionId: 's_mixed', authorId: 'u_mixed_dri', phaseId: null,
  authorKind: 'human', kind: 'message', text: '@研究员 请基于已确认的发布窗口给出结论。',
  mentions: ['a_mixed_worker'], toolCalls: [], replyMode: '',
})
db.close()

const parentDb = new DatabaseSync(dbPath)
const ctx = new Context() as Context & Record<string, any>
const sessionWork = new SqliteSessionWork(ctx, parentDb, { processId: 'mixed-inbox', heartbeatMs: 15 })
new SqliteSessionStore(ctx, parentDb)
new SqliteEventLog(ctx, parentDb)
const parentMemory = new SqliteMemoryStore(ctx, parentDb)
const agents = new AgentRegistry(ctx)
agents.register({ id: 'a_mixed_worker', kind: 'custom', title: '研究员', capabilities: [], description: '共享 Agent' })
Object.assign(ctx, { logger: { error() {}, warn() {}, info() {} }, llm: {
  configured: true,
  configuredFor: () => true,
  async chat() {
    writeFileSync(join(signalDir, 'inbox-memory-started'), 'started')
    const deadline = Date.now() + 12_000
    while (!existsSync(join(signalDir, 'release-inbox')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!existsSync(join(signalDir, 'release-inbox'))) throw new Error('test harness did not release Agent memory extraction')
    return JSON.stringify({ memories: [{ text: '已确认发布窗口为周五。', weight: 0.9 }] })
  },
} })
const inbox = new AgentInbox(ctx)
let childProcess: ReturnType<typeof spawn> | undefined

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert(predicate(), `timed out waiting for ${label}`)
}

try {
  const inboxWait = inbox.waitThrough('a_mixed_worker', 's_mixed', event.seq)
  await waitFor(() => existsSync(join(signalDir, 'inbox-memory-started')), 'Inbox memory extraction to start')
  const child = childProcess = spawn(process.execPath, [
    '--import', 'tsx', 'scripts/inbox-orchestrator-mix-worker.ts', dbPath, signalDir,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const waitForChildSignal = async (signal: string, label: string) => {
    const deadline = Date.now() + 12_000
    while (!existsSync(join(signalDir, signal)) && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`worker exited before ${label} (code=${child.exitCode}): ${errors || output}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert(existsSync(join(signalDir, signal)), `timed out waiting for ${label}; ${errors || output}`)
  }

  await waitForChildSignal('orchestrator-ready', 'Orchestrator process to start')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(existsSync(join(signalDir, 'history-barrier-passed')), false,
    'cross-process Agent mention waits while the Inbox memory cursor is behind')
  assert.equal(existsSync(join(signalDir, 'brain-started')), false,
    'Orchestrator brain cannot run before Inbox memory extraction completes')

  writeFileSync(join(signalDir, 'release-inbox'), 'release')
  await inboxWait
  await waitForChildSignal('history-barrier-passed', 'the Agent history barrier to pass')
  await waitForChildSignal('brain-started', 'Orchestrator brain after the Inbox barrier')
  const brainStart = JSON.parse(readFileSync(join(signalDir, 'brain-started'), 'utf8')) as { cursor: number; memory: string | null }
  assert.equal(brainStart.cursor, event.seq, 'Orchestrator observes the durable Agent cursor at the triggering event')
  assert.equal(brainStart.memory, '已确认发布窗口为周五。', 'Orchestrator starts only after the extracted memory is durable')
  writeFileSync(join(signalDir, 'release-brain'), 'release')

  const exitCode = await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`worker timeout: ${output}\n${errors}`)), 12_000)),
  ])
  assert.equal(exitCode, 0, `mixed worker failed: ${errors || output}`)
  const result = JSON.parse(readFileSync(join(signalDir, 'orchestrator-finished'), 'utf8')) as { brainCalls: number }
  assert.equal(result.brainCalls, 1, 'one explicit @ event produces exactly one coordinator decision')
  const verifyDb = new DatabaseSync(dbPath, { readOnly: true })
  const cursorRows = await parentMemory.recall('agent:a_mixed_worker', { kind: 'cursor:s_mixed', limit: 10 })
  assert(Math.max(0, ...cursorRows.map((row) => Number(row.text) || 0)) >= event.seq,
    'the durable Agent cursor remains at or beyond the triggering event')
  const replies = verifyDb.prepare(`SELECT count(*) AS n FROM events
    WHERE session_id = ? AND author_id = ? AND source_event_id = ? AND kind = 'message'`)
    .get('s_mixed', 'a_mixed_coordinator', event.id) as { n: number }
  assert.equal(replies.n, 1, 'the coordinator writes one causal reply after the memory barrier')
  const semanticMemory = await parentMemory.recall('agent:a_mixed_worker', { kind: 'conversation_fact:0', limit: 10 })
  assert.equal(semanticMemory.length, 1, 'the triggering event produces one durable memory record')
  verifyDb.close()

  // Recover a new mentioned message after the process that would have drained
  // it has crashed and left only an expiring SQLite lease behind.
  const recoverySignals = join(dir, 'recovery-signals')
  mkdirSync(recoverySignals)
  const recoveryContext = new Context()
  const recoveryLog = new SqliteEventLog(recoveryContext, parentDb)
  const recoveryEvent = recoveryLog.append({
    id: 'event_mixed_recovery', sessionId: 's_mixed', authorId: 'u_mixed_dri', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@研究员 补充：发布窗口已改为周六。',
    mentions: ['a_mixed_worker'], toolCalls: [], replyMode: '',
  })
  parentDb.prepare(`INSERT INTO session_work_owners(process_id, session_id, owner, expires_at)
    VALUES ('crashed-inbox', 's_mixed', 'agent-inbox', ?)`)
    .run(Date.now() + 30_000)

  const recoveryWorker = childProcess = spawn(process.execPath, [
    '--import', 'tsx', 'scripts/inbox-orchestrator-mix-worker.ts', dbPath, recoverySignals, recoveryEvent.id,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let recoveryOutput = '', recoveryErrors = ''
  recoveryWorker.stdout.setEncoding('utf8').on('data', (chunk: string) => { recoveryOutput += chunk })
  recoveryWorker.stderr.setEncoding('utf8').on('data', (chunk: string) => { recoveryErrors += chunk })
  const recoveryClosed = new Promise<number | null>((resolve, reject) => {
    recoveryWorker.once('error', reject)
    recoveryWorker.once('close', resolve)
  })
  const waitForRecoverySignal = async (signal: string, label: string) => {
    const deadline = Date.now() + 12_000
    while (!existsSync(join(recoverySignals, signal)) && Date.now() < deadline) {
      if (recoveryWorker.exitCode !== null) throw new Error(`recovery worker exited before ${label} (code=${recoveryWorker.exitCode}): ${recoveryErrors || recoveryOutput}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert(existsSync(join(recoverySignals, signal)), `timed out waiting for ${label}; ${recoveryErrors || recoveryOutput}`)
  }

  await waitForRecoverySignal('orchestrator-ready', 'recovery Orchestrator to start')
  await waitFor(() => Number((parentDb.prepare(`SELECT count(*) AS n FROM session_work_queue
    WHERE process_id = 'mixed-orchestrator' AND session_id = 's_mixed' AND owner = 'agent-inbox'`).get() as { n: number }).n) === 1,
  'recovery Inbox to queue behind the stale process lease')
  assert.equal(existsSync(join(recoverySignals, 'brain-started')), false,
    'a stale Inbox lease keeps the recovery Orchestrator behind the history barrier')
  parentDb.prepare('UPDATE session_work_owners SET expires_at = ? WHERE process_id = ? AND owner = ?')
    .run(Date.now() - 1, 'crashed-inbox', 'agent-inbox')
  await waitForRecoverySignal('history-barrier-passed', 'the recovery history barrier to pass')
  await waitForRecoverySignal('brain-started', 'the recovery Orchestrator brain to start')
  const recoveredBrain = JSON.parse(readFileSync(join(recoverySignals, 'brain-started'), 'utf8')) as { cursor: number; memory: string | null }
  assert.equal(recoveredBrain.cursor, recoveryEvent.seq, 'recovery replays the event through the durable Agent cursor')
  assert.equal(recoveredBrain.memory, '恢复进程已处理新消息。', 'recovery persists the message memory before coordinator work')
  writeFileSync(join(recoverySignals, 'release-brain'), 'release')
  const recoveryExitCode = await Promise.race([
    recoveryClosed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`recovery worker timeout: ${recoveryOutput}\n${recoveryErrors}`)), 12_000)),
  ])
  assert.equal(recoveryExitCode, 0, `recovery worker failed: ${recoveryErrors || recoveryOutput}`)
  const recoveredReply = parentDb.prepare(`SELECT count(*) AS n FROM events
    WHERE session_id = ? AND author_id = ? AND source_event_id = ? AND kind = 'message'`)
    .get('s_mixed', 'a_mixed_coordinator', recoveryEvent.id) as { n: number }
  assert.equal(recoveredReply.n, 1, 'lease recovery produces one causal Orchestrator reply')
  const recoveredMemory = (await parentMemory.recall('agent:a_mixed_worker', { kind: 'conversation_fact:0', limit: 10 }))
    .find((item) => item.sourceEventId === recoveryEvent.id)
  assert.equal(recoveredMemory?.text, '恢复进程已处理新消息。', 'the recovered Inbox memory is durable and source-linked')
  console.log('✓ Cross-process Inbox barrier and stale-lease recovery precede unique Orchestrator decisions')
} finally {
  if (childProcess?.exitCode === null) childProcess.kill('SIGKILL')
  sessionWork.dispose()
  parentDb.close()
  rmSync(dir, { recursive: true, force: true })
}
