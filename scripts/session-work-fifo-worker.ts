import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'

const [dbPath, sessionId, owner, signalDir, label] = process.argv.slice(2)
if (!dbPath || !sessionId || !owner || !signalDir || !label) {
  throw new Error('usage: session-work-fifo-worker.ts <db-path> <session-id> <owner> <signal-dir> <label>')
}

const db = new DatabaseSync(dbPath)
const work = new SqliteSessionWork(new Context(), db, { processId: `fifo-${label}`, heartbeatMs: 20 })
const signal = (name: string) => `${signalDir}/${label}.${name}`
const deadline = Date.now() + 10_000
let queued = false
try {
  while (Date.now() < deadline) {
    if (work.tryEnter(sessionId, owner)) break
    if (!queued) {
      writeFileSync(signal('queued'), 'queued')
      queued = true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!work.state().owners.includes(owner) || work.state().activeSessionId !== sessionId) {
    throw new Error(`timed out waiting to acquire ${sessionId}/${owner}`)
  }
  writeFileSync(signal('acquired'), 'acquired')
  while (!existsSync(signal('release')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!existsSync(signal('release'))) throw new Error(`timed out waiting to release ${label}`)
  work.leave(sessionId, owner)
} finally {
  work.dispose()
  db.close()
}
