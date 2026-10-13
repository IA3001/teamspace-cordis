import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'

const [dbPath, processId, signalDir] = process.argv.slice(2)
if (!dbPath || !processId || !signalDir) throw new Error('usage: worker DB_PATH PROCESS_ID SIGNAL_DIR')

const sessionId = 's_engine_race'
const ctx = new Context()
const db = new DatabaseSync(dbPath)
const sessionWork = new SqliteSessionWork(ctx, db, { processId, leaseMs: 30_000, heartbeatMs: 15 })
new SqliteSessionStore(ctx, db)
new SqliteEventLog(ctx, db)
new SqliteSettingsStore(ctx, db)
const engine = new OrchestratorEngine(ctx)
const startedPath = `${signalDir}/${processId}.brain-started`
const releasePath = `${signalDir}/${processId}.release`
const peerActivePath = `${signalDir}/${processId}.saw-peer-active`

engine.registerBrain({ async plan() {
  writeFileSync(startedPath, 'started')
  const deadline = Date.now() + 12_000
  while (!existsSync(releasePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!existsSync(releasePath)) throw new Error('test harness did not release the winning brain')
  return JSON.stringify({ reply: `由 ${processId} 处理一次`, reason: '完成', delegate: null })
} })
ctx.on('session-work/changed', () => engine.wakeQueue())

writeFileSync(`${signalDir}/${processId}.ready`, 'ready')
const poll = setInterval(() => {
  const activeOwner = db.prepare(`SELECT process_id FROM session_work_owners
    WHERE session_id = ? AND owner = ?`).get(sessionId, `orchestrator:${sessionId}`) as { process_id: string } | undefined
  if (activeOwner && activeOwner.process_id !== processId) writeFileSync(peerActivePath, activeOwner.process_id)
  engine.wakeQueue()
}, 15)
const beginDeadline = Date.now() + 8_000
while (!existsSync(`${signalDir}/begin`) && Date.now() < beginDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (!existsSync(`${signalDir}/begin`)) throw new Error('test harness did not start recovery workers')
engine.recoverPersistedWork()
const activeSessionId = sessionWork.state().activeSessionId
if (activeSessionId) writeFileSync(`${signalDir}/${processId}.waiting-for-shared-slot`, activeSessionId)
if (activeSessionId === sessionId) {
  writeFileSync(`${signalDir}/${processId}.waiting-for-lease`, 'waiting')
}

const deadline = Date.now() + 15_000
let turn = engine.turn(sessionId)
const durableRecoveryComplete = (): boolean => {
  try {
    if (sessionWork.state().activeSessionId) return false
    const state = ctx.settings.get<{ turns?: Array<[string, { stopReason?: string }]> } | null>(
      'orchestrator.runtime.v1', null)
    return state?.turns?.find(([id]) => id === sessionId)?.[1].stopReason === 'completed'
  } catch { return false }
}
while (!(turn.state === 'static' && turn.stopReason) && !durableRecoveryComplete() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  turn = engine.turn(sessionId)
}
const sharedCompletionObserved = durableRecoveryComplete()
clearInterval(poll)
sessionWork.dispose()
db.close()
if ((turn.state !== 'static' || turn.stopReason !== 'completed') && !sharedCompletionObserved) {
  throw new Error(`worker ${processId} did not observe completed recovery or a released durable completion: ${JSON.stringify(turn)}`)
}
