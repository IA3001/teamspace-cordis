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
const poll = setInterval(() => engine.wakeQueue(), 15)
const beginDeadline = Date.now() + 8_000
while (!existsSync(`${signalDir}/begin`) && Date.now() < beginDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (!existsSync(`${signalDir}/begin`)) throw new Error('test harness did not start recovery workers')
engine.recoverPersistedWork()

const deadline = Date.now() + 15_000
let turn = engine.turn(sessionId)
while (!(turn.state === 'static' && turn.stopReason) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  turn = engine.turn(sessionId)
}
clearInterval(poll)
sessionWork.dispose()
db.close()
if (turn.state !== 'static' || turn.stopReason !== 'completed') {
  throw new Error(`worker ${processId} did not observe completed recovery: ${JSON.stringify(turn)}`)
}
