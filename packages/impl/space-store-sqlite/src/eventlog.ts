// ctx.eventLog 的 sqlite 实现。语义契约见 seam/space-event 类注释。
import type { DatabaseSync } from 'node:sqlite'
import { EventLogError, EventLogService, validateEvent } from 'space-event'
import type { EventInput, ReactSummary, SessionEvent, ToolCall } from 'space-event'
import { reactToEvent, reactionsForEvents, unreactFromEvent } from './reactions.ts'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

function toEvent(r: Row): SessionEvent {
  const parse = (v: unknown, fallback: unknown) => {
    try {
      return JSON.parse(String(v ?? '')) ?? fallback
    } catch {
      return fallback
    }
  }
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    phaseId: (r.phase_id as string | null) ?? null,
    ts: r.ts as string,
    authorId: (r.author_id as string | null) ?? null,
    authorKind: r.author_kind as SessionEvent['authorKind'],
    kind: r.kind as SessionEvent['kind'],
    text: (r.text as string) ?? '',
    mentions: parse(r.mentions, []) as string[],
    toolCalls: parse(r.tool_calls, []) as ToolCall[],
    replyMode: (r.reply_mode as string) ?? '',
    replyTo: (r.reply_to as string | null) ?? null,
    voided: Number(r.voided) === 1,
    voidedBy: (r.voided_by as string | null) ?? null,
    voidedAt: (r.voided_at as string | null) ?? null,
    voidedReason: (r.voided_reason as string | null) ?? null,
  }
}

export class SqliteEventLog extends EventLogService {
  constructor(
    ctx: ConstructorParameters<typeof EventLogService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  append(input: EventInput): SessionEvent {
    validateEvent(input)
    const ts = input.ts ?? now()
    const next = this.nextSeq(input.sessionId)

    let seq = next
    if (input.seq !== undefined) {
      if (input.seq < next) {
        throw new EventLogError(
          'seq_regressed',
          `会话 ${input.sessionId} 的事件 ${input.id} 指定 seq=${input.seq}，但下一个可用序号是 ${next} —— 顺序不能回退`,
        )
      }
      seq = input.seq
    }

    try {
      this.db
        .prepare(
          `INSERT INTO events(id, session_id, seq, phase_id, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode, reply_to, voided)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          input.id,
          input.sessionId,
          seq,
          input.phaseId ?? null,
          ts,
          input.authorId ?? null,
          input.authorKind,
          input.kind,
          input.text,
          JSON.stringify(input.mentions ?? []),
          JSON.stringify(input.toolCalls ?? []),
          input.replyMode ?? '',
          input.replyTo ?? null,
        )
    } catch (e) {
      const msg = String((e as Error).message)
      if (/UNIQUE.*events\.id|PRIMARY KEY/i.test(msg)) {
        throw new EventLogError('duplicate_id', `事件 ID 重复：${input.id}（ID 是幂等键，不能重放同一条）`)
      }
      // (session_id, seq) 唯一索引冲突 = 并发下序号被别人占用，同样按回退处理。
      if (/events_session_seq|UNIQUE/i.test(msg)) {
        throw new EventLogError('seq_regressed', `会话 ${input.sessionId} 的 seq=${seq} 已被占用`)
      }
      throw e
    }
    // IM 化（2026-09-30）：任何事件落库后恰好一次广播信号 —— 实时推送
    // （plugins/space-push）与 AI 回流（orchestrator）共用同一条信号源。
    // 信号与落库绑死在同一方法 = 结构化 exactly-once（承 staging.commit 惯例）。
    const event = this.getRaw(input.id)!
    this.ctx.emit('space/event-appended', { event })
    return event
  }

  void(id: string, by: string, reason: string): number {
    if (!by.trim() || !reason.trim()) {
      // 废止必须留痕：没有 voided_by 就查不出"谁把记录撤了"。
      throw new EventLogError('invalid', `事件 ${id} 废止缺少 by/reason —— 废止必须留痕`)
    }
    const r = this.db
      .prepare(
        `UPDATE events SET voided = 1, voided_by = ?, voided_at = ?, voided_reason = ?
         WHERE id = ? AND voided = 0`,
      )
      .run(by, now(), reason, id)
    return Number(r.changes)
  }

  listBySession(sessionId: string): SessionEvent[] {
    return (
      this.db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC`).all(sessionId) as Row[]
    ).map(toEvent)
  }

  lastSeq(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS v FROM events WHERE session_id = ?`)
      .get(sessionId) as { v: number }
    return Number(r.v)
  }

  search(sessionId: string, query: string): SessionEvent[] {
    const q = query.trim()
    if (!q) return []
    // trigram 要求查询词 ≥ 3 字符；2 字词走 LIKE 兜底（承旧链 2026-09-16 实测结论）。
    if ([...q].length >= 3) {
      const phrase = `"${q.replaceAll('"', '""')}"`
      const rows = this.db
        .prepare(
          `SELECT e.* FROM events e
           JOIN events_fts f ON f.rowid = e.rowid
           WHERE events_fts MATCH ? AND e.session_id = ?
           ORDER BY e.seq ASC`,
        )
        .all(phrase, sessionId) as Row[]
      return rows.map(toEvent)
    }
    const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    return (
      this.db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY seq ASC`,
        )
        .all(sessionId, `%${escaped}%`) as Row[]
    ).map(toEvent)
  }

  // ── 表情回应（IM 化 2026-10-01）：SQL 细节在 reactions.ts，这里只组合 ────

  async react(eventId: string, userId: string, emoji: string): Promise<ReactSummary[]> {
    return reactToEvent(this.db, eventId, userId, emoji)
  }

  async unreact(eventId: string, userId: string, emoji: string): Promise<ReactSummary[]> {
    return unreactFromEvent(this.db, eventId, userId, emoji)
  }

  async reactions(eventIds: string[]): Promise<Record<string, ReactSummary[]>> {
    return reactionsForEvents(this.db, eventIds)
  }

  private nextSeq(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS v FROM events WHERE session_id = ?`)
      .get(sessionId) as { v: number }
    return Number(r.v)
  }

  private getRaw(id: string): SessionEvent | undefined {
    const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Row | undefined
    return r ? toEvent(r) : undefined
  }
}
