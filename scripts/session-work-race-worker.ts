import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { Context } from 'cordis'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'

const [dbPath, sessionId, ownerArg] = process.argv.slice(2)
if (!dbPath || !sessionId) throw new Error('usage: session-work-race-worker.ts <db-path> <session-id> [owner]')
const db = new DatabaseSync(dbPath)
const service = new SqliteSessionWork(new Context(), db, { processId: `race-${randomUUID()}` })
const deadline = Number(process.env.SESSION_RACE_AT ?? Date.now())
while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
const owner = ownerArg ?? `owner-${sessionId}`
const admitted = service.tryEnter(sessionId, owner)
process.stdout.write(JSON.stringify({ sessionId, owner, admitted }) + '\n')
service.dispose()
db.close()
