// 表情回应的 SQL 辅助（IM 化 2026-10-01）。
// 不自成 Service：由 SqliteEventLog 组合调用（三个方法挂在 eventlog 缝上，
// 语义契约见 seam/space-event 的 react/unreact/reactions 注释）。
// 单独成文件只为了 eventlog.ts 别再膨胀 —— db 由调用方注入（承 users.ts 惯例）。
import type { DatabaseSync } from 'node:sqlite'
import type { ReactSummary } from 'space-event'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

/** 行 → 汇总：按 emoji 分组，users 按回应时间升序（先到先得，稳定展示）。 */
function summarize(rows: Row[]): ReactSummary[] {
  const byEmoji = new Map<string, ReactSummary>()
  for (const r of rows) {
    const emoji = r.emoji as string
    let s = byEmoji.get(emoji)
    if (!s) {
      s = { emoji, count: 0, users: [] }
      byEmoji.set(emoji, s)
    }
    s.count++
    s.users.push(r.user_id as string)
  }
  // 按数量降序、同数量按 emoji 稳定排序（热回应排前面）。
  return [...byEmoji.values()].sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : 1))
}

/** 单事件汇总（react/unreact 的返回值）。 */
export function summarizeEvent(db: DatabaseSync, eventId: string): ReactSummary[] {
  const rows = db
    .prepare(`SELECT emoji, user_id FROM msg_reactions WHERE event_id = ? ORDER BY created_at ASC`)
    .all(eventId) as Row[]
  return summarize(rows)
}

/** 打回应：INSERT OR IGNORE 幂等（一人一事件一个 emoji 只一条，主键兜住）。 */
export function reactToEvent(db: DatabaseSync, eventId: string, userId: string, emoji: string): ReactSummary[] {
  db.prepare(
    `INSERT OR IGNORE INTO msg_reactions(event_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
  ).run(eventId, userId, emoji, now())
  return summarizeEvent(db, eventId)
}

/** 撤回应：DELETE 天然幂等（没回应过 = 0 行受影响，照常返回现状）。 */
export function unreactFromEvent(db: DatabaseSync, eventId: string, userId: string, emoji: string): ReactSummary[] {
  db.prepare(`DELETE FROM msg_reactions WHERE event_id = ? AND user_id = ? AND emoji = ?`)
    .run(eventId, userId, emoji)
  return summarizeEvent(db, eventId)
}

/** 批量查一组事件的回应（一次 IN 查询，杜绝时间线渲染的 N+1）。 */
export function reactionsForEvents(db: DatabaseSync, eventIds: string[]): Record<string, ReactSummary[]> {
  const out: Record<string, ReactSummary[]> = {}
  if (eventIds.length === 0) return out
  const placeholders = eventIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT event_id, emoji, user_id, created_at FROM msg_reactions
       WHERE event_id IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(...eventIds) as Array<Row & { event_id: string }>
  // 按 event_id 分组后各自 summarize（一次往返，内存分组）。
  const byEvent = new Map<string, Row[]>()
  for (const r of rows) {
    const list = byEvent.get(r.event_id) ?? []
    list.push(r)
    byEvent.set(r.event_id, list)
  }
  for (const [id, list] of byEvent) out[id] = summarize(list)
  return out
}
