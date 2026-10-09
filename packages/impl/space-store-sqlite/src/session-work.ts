import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SessionWorkService } from 'space-session-work'
import type { SessionWorkState } from 'space-session-work'

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000

/** SQLite-backed, process-shared session slot with expiring ownership and FIFO waiters. */
export class SqliteSessionWork extends SessionWorkService {
  readonly processId: string
  private readonly leaseMs: number
  private readonly heartbeat: ReturnType<typeof setInterval>
  private lastState = ''

  constructor(
    ctx: ConstructorParameters<typeof SessionWorkService>[0],
    private readonly db: DatabaseSync,
    options: { processId?: string; leaseMs?: number; heartbeatMs?: number } = {},
  ) {
    super(ctx)
    // SQLite serializes BEGIN IMMEDIATE across processes. Wait briefly for the
    // winner instead of leaking SQLITE_BUSY from simultaneous slot acquisition.
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.processId = options.processId ?? randomUUID()
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.lastState = JSON.stringify(this.readState())
    this.heartbeat = setInterval(() => {
      this.refreshLeases()
      const state = this.state()
      const signature = JSON.stringify(state)
      if (signature !== this.lastState) {
        this.lastState = signature
        this.ctx.emit('session-work/changed', state)
      }
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  tryEnter(sessionId: string, owner: string): boolean {
    if (!sessionId.trim() || !owner.trim()) return false
    const now = Date.now()
    const expiresAt = now + this.leaseMs
    this.db.exec('BEGIN IMMEDIATE')
    let admitted = false
    try {
      this.purgeExpired(now)
      const activeRows = this.db.prepare('SELECT DISTINCT session_id FROM session_work_owners').all() as Array<{ session_id: string }>
      if (activeRows.length > 1) throw new Error('检测到多个活动会话租约，拒绝继续以免破坏单会话约束')
      const activeSessionId = activeRows[0]?.session_id ?? null
      const logicalOwner = this.db.prepare('SELECT process_id FROM session_work_owners WHERE session_id = ? AND owner = ?')
        .get(sessionId, owner) as { process_id: string } | undefined
      if (logicalOwner && logicalOwner.process_id !== this.processId) {
        // Same-session agents may overlap, but a logical owner must never be
        // duplicated by another process (notably the Orchestrator coordinator).
        this.enqueue(sessionId, owner, now, expiresAt)
      } else if (logicalOwner) {
        this.db.prepare('UPDATE session_work_owners SET expires_at = ? WHERE process_id = ? AND session_id = ? AND owner = ?')
          .run(expiresAt, this.processId, sessionId, owner)
        this.db.prepare('DELETE FROM session_work_queue WHERE process_id = ? AND session_id = ? AND owner = ?')
          .run(this.processId, sessionId, owner)
        admitted = true
      } else if (activeSessionId && activeSessionId !== sessionId) {
        this.enqueue(sessionId, owner, now, expiresAt)
      } else {
        const head = this.db.prepare('SELECT session_id FROM session_work_queue ORDER BY queue_id LIMIT 1').get() as { session_id: string } | undefined
        if (!activeSessionId && head && head.session_id !== sessionId) {
          this.enqueue(sessionId, owner, now, expiresAt)
        } else {
          this.db.prepare('INSERT OR IGNORE INTO session_work_owners(process_id, session_id, owner, expires_at) VALUES (?, ?, ?, ?)')
            .run(this.processId, sessionId, owner, expiresAt)
          this.db.prepare('DELETE FROM session_work_queue WHERE process_id = ? AND session_id = ? AND owner = ?')
            .run(this.processId, sessionId, owner)
          if (!activeSessionId) this.db.prepare('DELETE FROM session_work_queue WHERE session_id = ?').run(sessionId)
          admitted = true
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.publishIfChanged()
    return admitted
  }

  leave(sessionId: string, owner: string): void {
    this.db.prepare('DELETE FROM session_work_owners WHERE process_id = ? AND session_id = ? AND owner = ?')
      .run(this.processId, sessionId, owner)
    this.publishIfChanged()
  }

  cancelQueued(sessionId: string, owner: string): void {
    this.db.prepare('DELETE FROM session_work_queue WHERE process_id = ? AND session_id = ? AND owner = ?')
      .run(this.processId, sessionId, owner)
    this.publishIfChanged()
  }

  state(): SessionWorkState {
    this.purgeExpired(Date.now())
    return this.readState()
  }

  /** Stop timers; leave leases to expire to simulate an ungraceful process exit. */
  dispose(): void { clearInterval(this.heartbeat) }

  private enqueue(sessionId: string, owner: string, now: number, expiresAt: number): void {
    this.db.prepare(`INSERT INTO session_work_queue(process_id, session_id, owner, enqueued_at, expires_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(process_id, session_id, owner) DO UPDATE SET expires_at = excluded.expires_at`)
      .run(this.processId, sessionId, owner, now, expiresAt)
  }

  private refreshLeases(): void {
    const expiresAt = Date.now() + this.leaseMs
    this.db.prepare('UPDATE session_work_owners SET expires_at = ? WHERE process_id = ?').run(expiresAt, this.processId)
    this.db.prepare('UPDATE session_work_queue SET expires_at = ? WHERE process_id = ?').run(expiresAt, this.processId)
  }

  private purgeExpired(now: number): void {
    this.db.prepare('DELETE FROM session_work_owners WHERE expires_at <= ?').run(now)
    this.db.prepare('DELETE FROM session_work_queue WHERE expires_at <= ?').run(now)
  }

  private readState(): SessionWorkState {
    const active = this.db.prepare('SELECT DISTINCT session_id FROM session_work_owners ORDER BY session_id').all() as Array<{ session_id: string }>
    const owners = this.db.prepare('SELECT owner FROM session_work_owners WHERE session_id = ? ORDER BY process_id, owner')
      .all(active[0]?.session_id ?? '') as Array<{ owner: string }>
    const waiting = this.db.prepare('SELECT session_id, owner FROM session_work_queue ORDER BY queue_id').all() as Array<{ session_id: string; owner: string }>
    return {
      activeSessionId: active[0]?.session_id ?? null,
      owners: owners.map((row) => row.owner),
      queue: waiting.map((item, index) => ({ sessionId: item.session_id, owner: item.owner, position: index + 1 })),
    }
  }

  private publishIfChanged(): void {
    const state = this.state()
    const signature = JSON.stringify(state)
    if (signature === this.lastState) return
    this.lastState = signature
    this.ctx.emit('session-work/changed', state)
  }
}
