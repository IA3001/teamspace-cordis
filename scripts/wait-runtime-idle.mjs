// Wait for startup recovery and Agent Inbox work to release the shared session
// slot before a live runtime verifier creates another session.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const envPath = resolve(process.cwd(), '.env')
const envSource = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const configuredDb = process.env.DB_PATH ?? envSource.match(/^DB_PATH=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
const dbPath = resolve(process.cwd(), configuredDb || 'data/database.db')
const maxWaitMs = 5 * 60_000
const stableIdleMs = 3_000
const pollMs = 1_000
const db = new DatabaseSync(dbPath, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')

const countOwners = db.prepare('SELECT count(*) AS n FROM session_work_owners WHERE expires_at > ?')
const countQueue = db.prepare('SELECT count(*) AS n FROM session_work_queue WHERE expires_at > ?')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

let idleSince = null
let lastNotice = 0
const startedAt = Date.now()
try {
  while (Date.now() - startedAt < maxWaitMs) {
    const now = Date.now()
    const owners = Number(countOwners.get(now).n)
    const queued = Number(countQueue.get(now).n)
    if (owners === 0 && queued === 0) {
      idleSince ??= now
      if (now - idleSince >= stableIdleMs) {
        console.log(`✓ Agent 调度空闲稳定 ${stableIdleMs / 1000}s（累计等待 ${Math.round((now - startedAt) / 1000)}s）`)
        process.exitCode = 0
        break
      }
    } else {
      idleSince = null
      if (now - lastNotice >= 15_000) {
        console.log(`· 等待 Agent 处理排空（活动会话 ${owners}，排队任务 ${queued}）`)
        lastNotice = now
      }
    }
    await delay(pollMs)
  }
  if (process.exitCode !== 0) {
    console.error(`✗ Agent 调度在 ${maxWaitMs / 1000}s 内未空闲；本次运行时验收不启动新任务`)
    process.exitCode = 1
  }
} finally {
  db.close()
}
