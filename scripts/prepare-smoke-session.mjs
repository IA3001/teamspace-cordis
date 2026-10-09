// Local/preproduction-only fixture setup for smoke.sh. Creates one private
// session owned by smoke_gate so invite-only session reads remain exercised.
import { DatabaseSync } from 'node:sqlite'

if (process.env.NODE_ENV === 'production') {
  console.error('拒绝在 production 环境创建 smoke fixture')
  process.exit(2)
}
const userId = process.argv[2]
if (!userId || !/^u_[A-Za-z0-9_-]+$/.test(userId)) {
  console.error('用法: node scripts/prepare-smoke-session.mjs <human-user-id>')
  process.exit(2)
}
// 每轮 smoke 使用独立会话，避免旧运行中的失败事件污染本轮断言。
const runId = Date.now().toString(36)
const sessionId = `s_smoke_${runId}`
const db = new DatabaseSync('data/database.db')
db.exec('PRAGMA busy_timeout=5000')
try {
  const user = db.prepare("SELECT id FROM users WHERE id=? AND kind='human'").get(userId)
  const analyst = db.prepare("SELECT id FROM users WHERE id='a_analyst' AND kind='agent'").get()
  const coordinator = db.prepare("SELECT id FROM users WHERE id='a_coordinator' AND kind='agent'").get()
  if (!user || !analyst || !coordinator) throw new Error('smoke fixture requires the logged-in human, seeded a_analyst, and seeded a_coordinator identities')
  const createdAt = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT OR IGNORE INTO sessions(id,title,current_phase,status,created_at,updated_at)
      VALUES (?, 'Smoke 验收会话', NULL, 'open', ?, ?)`).run(sessionId, createdAt, createdAt)
    db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
      VALUES (?,?,'群主','active',?,NULL,'Smoke 验收')
      ON CONFLICT(session_id,principal_id) DO UPDATE SET role='群主',status='active',left_at=NULL`).run(sessionId, userId, createdAt)
    db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
      VALUES (?,'a_analyst','需求分析师','active',?,NULL,'需求分析师')
      ON CONFLICT(session_id,principal_id) DO UPDATE SET status='active',left_at=NULL`).run(sessionId, createdAt)
    db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
      VALUES (?,'a_coordinator','协调者','active',?,NULL,'协调者')
      ON CONFLICT(session_id,principal_id) DO UPDATE SET status='active',left_at=NULL`).run(sessionId, createdAt)
    db.prepare(`INSERT OR IGNORE INTO events(id,session_id,seq,phase_id,ts,author_id,author_kind,kind,text,mentions,tool_calls,reply_mode)
      VALUES (?, ?,1,NULL,?,NULL,'system','system','Smoke 验收会话已准备。','[]','[]','')`).run(`evt_smoke_${runId}`, sessionId, createdAt)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  console.log(sessionId)
} finally {
  db.close()
}
