import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { Context } from 'cordis'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'

const dir = mkdtempSync(join(tmpdir(), 'teamspace-session-work-'))
const dbPath = join(dir, 'queue.db')
const migration = readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0024_durable_session_work.up.sql'), 'utf8')
const ownerMigration = readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0026_unique_session_work_owner.up.sql'), 'utf8')
const ownerRollback = readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0026_unique_session_work_owner.down.sql'), 'utf8')
const connections = [new DatabaseSync(dbPath), new DatabaseSync(dbPath), new DatabaseSync(dbPath)]
for (const db of connections) db.exec(migration)
connections[0]!.prepare('INSERT INTO session_work_owners(process_id, session_id, owner, expires_at) VALUES (?, ?, ?, ?)')
  .run('legacy-a', 'legacy-session', 'orchestrator:legacy-session', 100)
connections[0]!.prepare('INSERT INTO session_work_owners(process_id, session_id, owner, expires_at) VALUES (?, ?, ?, ?)')
  .run('legacy-b', 'legacy-session', 'orchestrator:legacy-session', 200)
for (const db of connections) db.exec(ownerMigration)
const migratedLease = connections[0]!.prepare('SELECT process_id, expires_at FROM session_work_owners WHERE session_id = ?').get('legacy-session') as { process_id: string; expires_at: number }
assert.equal(migratedLease.process_id, 'legacy-b', 'migration keeps the duplicate lease with the latest expiry')
assert.equal(migratedLease.expires_at, 200)
connections[0]!.prepare('DELETE FROM session_work_owners WHERE session_id = ?').run('legacy-session')
const rollbackDb = new DatabaseSync(':memory:')
rollbackDb.exec(migration)
rollbackDb.exec(ownerMigration)
rollbackDb.exec(ownerRollback)
assert.equal(rollbackDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_work_owner_unique'").get().n, 0)
rollbackDb.close()
const services = connections.map((db, i) => new SqliteSessionWork(new Context(), db, {
  processId: `process-${i}`, leaseMs: 250, heartbeatMs: 1_000_000,
}))

try {
  assert.equal(services[0]!.tryEnter('s-active', 'worker-a'), true)
  assert.equal(services[1]!.tryEnter('s-active', 'worker-b'), true, 'parallel workers may share one active session')
  assert.equal(services[2]!.tryEnter('s-second', 'worker-c'), false)
  assert.equal(services[1]!.tryEnter('s-third', 'worker-d'), false)
  assert.deepEqual(services[0]!.state().queue.map((item) => [item.sessionId, item.position]), [['s-second', 1], ['s-third', 2]])
  services[0]!.leave('s-active', 'worker-a')
  services[1]!.leave('s-active', 'worker-b')
  assert.equal(services[2]!.tryEnter('s-third', 'worker-d'), false, 'later sessions cannot pass the FIFO head')
  assert.equal(services[2]!.tryEnter('s-second', 'worker-c'), true)
  assert.equal(services[1]!.state().activeSessionId, 's-second', 'all connections observe the shared active slot')
  services[2]!.leave('s-second', 'worker-c')
  assert.equal(services[2]!.tryEnter('s-third', 'worker-d'), true)

  // A process crash leaves a lease, not a permanent lock. After expiry another process recovers.
  assert.equal(services[0]!.tryEnter('s-fourth', 'worker-e'), false)
  services[2]!.dispose()
  // Expire the crashed process and its stale wait intent directly instead of
  // racing a 250ms wall-clock sleep under a busy runtime gate.
  const expiredAt = Date.now() - 1
  connections[0]!.prepare('UPDATE session_work_owners SET expires_at = ? WHERE session_id = ?')
    .run(expiredAt, 's-third')
  connections[0]!.prepare('UPDATE session_work_queue SET expires_at = ? WHERE session_id = ?')
    .run(expiredAt, 's-third')
  assert.equal(services[0]!.tryEnter('s-fourth', 'worker-e'), true)
  assert.equal(services[1]!.state().activeSessionId, 's-fourth')

  // Two OS processes racing for different sessions must still see one SQLite slot.
  const raceDbPath = join(dir, 'race.db')
  const raceDb = new DatabaseSync(raceDbPath)
  raceDb.exec(migration)
  raceDb.exec(ownerMigration)
  const raceAt = Date.now() + 1_000
  const race = await Promise.all(['race-a', 'race-b'].map((sessionId) => new Promise<{ sessionId: string; admitted: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/session-work-race-worker.ts', raceDbPath, sessionId], {
      cwd: process.cwd(), env: { ...process.env, SESSION_RACE_AT: String(raceAt) },
    })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`race worker failed (${code}): ${errors}`))
      try { resolve(JSON.parse(output.trim().split('\n').at(-1)!) as { sessionId: string; admitted: boolean }) }
      catch (error) { reject(error) }
    })
  })))
  assert.equal(race.filter((item) => item.admitted).length, 1, 'concurrent OS processes cannot claim separate sessions')
  const raceState = raceDb.prepare('SELECT count(DISTINCT session_id) AS sessions FROM session_work_owners').get() as { sessions: number }
  assert.equal(raceState.sessions, 1)
  raceDb.close()

  // Distinct OS processes may share a session for parallel Agents, but cannot
  // claim the same logical coordinator owner and make duplicate decisions.
  const sameOwnerDbPath = join(dir, 'same-owner.db')
  const sameOwnerDb = new DatabaseSync(sameOwnerDbPath)
  sameOwnerDb.exec(migration)
  sameOwnerDb.exec(ownerMigration)
  const ownerRaceAt = Date.now() + 1_000
  const sameOwnerRace = await Promise.all(['process-a', 'process-b'].map(() => new Promise<{ admitted: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/session-work-race-worker.ts', sameOwnerDbPath, 's-coordinator', 'orchestrator:s-coordinator'], {
      cwd: process.cwd(), env: { ...process.env, SESSION_RACE_AT: String(ownerRaceAt) },
    })
    let output = '', errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`same-owner race worker failed (${code}): ${errors}`))
      try { resolve(JSON.parse(output.trim().split('\n').at(-1)!) as { admitted: boolean }) }
      catch (error) { reject(error) }
    })
  })))
  assert.equal(sameOwnerRace.filter((item) => item.admitted).length, 1, 'same logical owner cannot be admitted by two OS processes')
  assert.equal((sameOwnerDb.prepare('SELECT count(*) AS n FROM session_work_owners WHERE session_id = ? AND owner = ?').get('s-coordinator', 'orchestrator:s-coordinator') as { n: number }).n, 1)
  assert.equal((sameOwnerDb.prepare('SELECT count(*) AS n FROM session_work_queue WHERE session_id = ? AND owner = ?').get('s-coordinator', 'orchestrator:s-coordinator') as { n: number }).n, 1, 'losing process retains a durable retry intent')
  sameOwnerDb.close()
  console.log('✓ SQLite session gate enforces one active session, one process per logical owner, FIFO order, and crash lease recovery')
} finally {
  for (const service of services) service.dispose()
  for (const db of connections) db.close()
  rmSync(dir, { recursive: true, force: true })
}
