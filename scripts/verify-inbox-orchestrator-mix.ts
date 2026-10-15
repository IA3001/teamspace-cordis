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
eventLog.append({
  id: 'event_prior', sessionId: 's_mixed', authorId: 'u_mixed_dri', phaseId: null,
  authorKind: 'human', kind: 'message', text: '以前的讨论：发布窗口已确认周五。',
  mentions: [], toolCalls: [], replyMode: '',
})
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
  await waitForChildSignal('direct-task-started', 'the explicit @ task to dispatch while Inbox history is still pending')
  const dispatched = JSON.parse(readFileSync(join(signalDir, 'direct-task-started'), 'utf8')) as { eventId: string; target: string }
  assert.equal(dispatched.eventId, event.id, 'the immediate task keeps the triggering message as its source')
  assert.equal(dispatched.target, '研究员', 'the task is routed to the explicitly mentioned Agent')
  assert.equal(await parentMemory.recall('agent:a_mixed_worker', { kind: 'conversation_fact:0' }).then((items) => items.length), 0,
    'direct task dispatch does not wait for background memory extraction')

  writeFileSync(join(signalDir, 'release-inbox'), 'release')
  await inboxWait
  await waitForChildSignal('task-dispatched', 'the explicit @ task handoff to finish')

  const exitCode = await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`worker timeout: ${output}\n${errors}`)), 12_000)),
  ])
  assert.equal(exitCode, 0, `mixed worker failed: ${errors || output}`)
  const result = JSON.parse(readFileSync(join(signalDir, 'orchestrator-finished'), 'utf8')) as { dispatched: boolean }
  assert.equal(result.dispatched, true, 'the direct @ task is dispatched while inbox history continues independently')
  const verifyDb = new DatabaseSync(dbPath, { readOnly: true })
  const cursorRows = await parentMemory.recall('agent:a_mixed_worker', { kind: 'cursor:s_mixed', limit: 10 })
  assert(Math.max(0, ...cursorRows.map((row) => Number(row.text) || 0)) >= event.seq,
    'the durable Agent inbox cursor still catches up after the direct task dispatch')
  const semanticMemory = await parentMemory.recall('agent:a_mixed_worker', { kind: 'conversation_fact:0', limit: 10 })
  assert.equal(semanticMemory.length, 1, 'the prior unmentioned message still produces one durable memory record')
  assert.equal(semanticMemory[0]?.sourceEventId, 'event_prior', 'background memory remains tied to its own source')
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
  await waitForRecoverySignal('direct-task-started', 'the recovered @ task to dispatch before inbox lease recovery')
  const recoveredDispatch = JSON.parse(readFileSync(join(recoverySignals, 'direct-task-started'), 'utf8')) as { eventId: string; target: string }
  assert.equal(recoveredDispatch.eventId, recoveryEvent.id, 'recovery immediately dispatches the unhandled @ message')
  await waitFor(() => Number((parentDb.prepare(`SELECT count(*) AS n FROM session_work_queue
    WHERE process_id = 'mixed-orchestrator' AND session_id = 's_mixed' AND owner = 'agent-inbox'`).get() as { n: number }).n) === 1,
  'recovery Inbox to queue behind the stale process lease')
  parentDb.prepare('UPDATE session_work_owners SET expires_at = ? WHERE process_id = ? AND owner = ?')
    .run(Date.now() - 1, 'crashed-inbox', 'agent-inbox')
  const recoveryExitCode = await Promise.race([
    recoveryClosed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`recovery worker timeout: ${recoveryOutput}\n${recoveryErrors}`)), 12_000)),
  ])
  assert.equal(recoveryExitCode, 0, `recovery worker failed: ${recoveryErrors || recoveryOutput}`)
  const recoveredCursor = await parentMemory.recall('agent:a_mixed_worker', { kind: 'cursor:s_mixed', limit: 10 })
  assert(Math.max(0, ...recoveredCursor.map((item) => Number(item.text) || 0)) >= recoveryEvent.seq,
    'the background inbox catches up after direct task dispatch and lease recovery')
  console.log('✓ Direct @ tasks dispatch without waiting for background Inbox history; cursor recovery remains durable')
} finally {
  if (childProcess?.exitCode === null) childProcess.kill('SIGKILL')
  sessionWork.dispose()
  parentDb.close()
  rmSync(dir, { recursive: true, force: true })
}
