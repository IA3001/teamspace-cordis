// ctx.staging 的 sqlite 实现。语义契约见 seam/space-staging 类注释。
//
// commit（/commit 的执行体）也落在这里：把暂存区按 seq 换行拼接成一条
// 人类发言事件（走同插件的 eventLog）、清空暂存、发恰好一次 'staging/plan'
// 内核事件 —— 信号与「落库 + 清空」绑死在同一个方法里，"恰好一次"才是结构保证。
// （教训：不要在 Service 里用 #私有字段存订阅回调 —— cordis 服务代理重绑 this
//  之后品牌校验会炸，2026-09-27 实测；内核事件总线才是 cordis 的惯用法。）
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StagingError, StagingService } from 'space-staging'
import type { Entry } from 'space-staging'
import { EventLogService } from 'space-event'
import type { SessionEvent } from 'space-event'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

function toEntry(r: Row): Entry {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    authorId: r.author_id as string,
    seq: Number(r.seq),
    text: r.text as string,
    createdAt: r.created_at as string,
  }
}

export class SqliteStagingStore extends StagingService {
  constructor(
    ctx: ConstructorParameters<typeof StagingService>[0],
    private readonly db: DatabaseSync,
    private readonly eventLog: EventLogService,
  ) {
    super(ctx)
  }

  append(sessionId: string, authorId: string, text: string): Entry {
    if (!text.trim()) {
      throw new StagingError('empty_text', '暂存条目文本为空（纯空白不入暂存区）')
    }
    const entry: Entry = {
      id: randomUUID(),
      sessionId,
      authorId,
      seq: this.nextSeq(sessionId),
      text,
      createdAt: now(),
    }
    this.db
      .prepare(
        `INSERT INTO staging_entries(id, session_id, author_id, seq, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.sessionId, entry.authorId, entry.seq, entry.text, entry.createdAt)
    return entry
  }

  list(sessionId: string): Entry[] {
    return (
      this.db
        .prepare(`SELECT * FROM staging_entries WHERE session_id = ? ORDER BY seq ASC`)
        .all(sessionId) as Row[]
    ).map(toEntry)
  }

  count(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT count(*) AS n FROM staging_entries WHERE session_id = ?`)
      .get(sessionId) as { n: number }
    return Number(r.n)
  }

  remove(sessionId: string, seq: number, authorId: string): void {
    const row = this.get(sessionId, seq)
    if (!row) {
      throw new StagingError('not_found', `会话 ${sessionId} 的暂存区没有 #${seq}`)
    }
    if (row.authorId !== authorId) {
      // 硬约束：只有作者能撤自己的条目 —— 别人的 #N 对你不是可删对象。
      throw new StagingError('not_author', `#${seq} 是 ${row.authorId} 的条目，${authorId} 无权删除`)
    }
    this.db.prepare(`DELETE FROM staging_entries WHERE id = ?`).run(row.id)
  }

  update(sessionId: string, seq: number, authorId: string, text: string): Entry {
    if (!text.trim()) {
      throw new StagingError('empty_text', `#${seq} 的新文本为空（要删请用 /del ${seq}）`)
    }
    const row = this.get(sessionId, seq)
    if (!row) {
      throw new StagingError('not_found', `会话 ${sessionId} 的暂存区没有 #${seq}`)
    }
    if (row.authorId !== authorId) {
      // 硬约束：只有作者能改自己的条目。
      throw new StagingError('not_author', `#${seq} 是 ${row.authorId} 的条目，${authorId} 无权改写`)
    }
    this.db.prepare(`UPDATE staging_entries SET text = ? WHERE id = ?`).run(text, row.id)
    return { ...row, text }
  }

  clear(sessionId: string): number {
    const r = this.db.prepare(`DELETE FROM staging_entries WHERE session_id = ?`).run(sessionId)
    return Number(r.changes)
  }

  commit(sessionId: string, authorId: string): { event: SessionEvent; merged: number } | null {
    const entries = this.list(sessionId)
    if (entries.length === 0) return null
    // 合并语义（用户拍板 2026-09-27）：按 seq 顺序换行拼接成一条人类发言。
    const text = entries.map((e) => e.text).join('\n')
    const event = this.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId,
      phaseId: null,
      authorKind: 'human',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
    // 先落事件、后清暂存：顺序必须是「落库成功 → 清空 → 发信号」，
    // 任何一步抛错都不会发出信号（宁可让人重发 /commit，不可多触发 Plan）。
    // 信号走内核事件总线（seam 契约）：P2 由验收脚本订阅观测，P3 orchestrator
    // 原地接管订阅 —— 接缝不变。
    this.clear(sessionId)
    this.ctx.emit('staging/plan', { sessionId, authorId, event })
    return { event, merged: entries.length }
  }

  private get(sessionId: string, seq: number): Entry | undefined {
    const r = this.db
      .prepare(`SELECT * FROM staging_entries WHERE session_id = ? AND seq = ?`)
      .get(sessionId, seq) as Row | undefined
    return r ? toEntry(r) : undefined
  }

  private nextSeq(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS v FROM staging_entries WHERE session_id = ?`)
      .get(sessionId) as { v: number }
    return Number(r.v)
  }
}
