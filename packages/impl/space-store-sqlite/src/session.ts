// ctx.session 的 sqlite 实现。语义契约见 seam/space-session 类注释。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  SessionError,
  SessionService,
  isRole,
} from 'space-session'
import type {
  JoinInput,
  Membership,
  MemberStatus,
  Session,
  SessionInput,
  SessionStatus,
} from 'space-session'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()

function toSession(r: Row): Session {
  return {
    id: r.id as string,
    title: r.title as string,
    currentPhase: (r.current_phase as string | null) ?? null,
    status: r.status as SessionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function toMembership(r: Row): Membership {
  return {
    sessionId: r.session_id as string,
    principalId: r.principal_id as string,
    role: r.role as Membership['role'],
    status: r.status as MemberStatus,
    duty: (r.duty as string) ?? '',
    joinedAt: r.joined_at as string,
    leftAt: (r.left_at as string | null) ?? null,
  }
}

/** 把 sqlite 约束错误翻译成 seam 的错误码（不许自造错误串，规律 3）。 */
function mapConstraintError(e: unknown): never {
  const code = (e as { code?: string }).code ?? ''
  const msg = (e as { message?: string }).message ?? String(e)
  // 走到映射前的分支都排除了主键冲突，能撞的只剩
  // idx_one_active_dri_per_session（承旧 member.go 同一推导）。
  if (code.includes('CONSTRAINT') || /UNIQUE|CHECK/i.test(msg)) {
    throw new SessionError('dri_already_set', `该会话已有在册 DRI（${msg}）`)
  }
  throw e as Error
}

export class SqliteSessionStore extends SessionService {
  constructor(
    ctx: ConstructorParameters<typeof SessionService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  createSession(input: SessionInput): Session {
    if (!input.title || !input.title.trim()) {
      throw new SessionError('invalid_input', '会议标题不能为空')
    }
    const id = input.id ?? `s_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const t = now()
    try {
      this.db
        .prepare(
          `INSERT INTO sessions(id, title, current_phase, status, created_at, updated_at)
           VALUES (?, ?, NULL, 'open', ?, ?)`,
        )
        .run(id, input.title, t, t)
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error).message))) {
        throw new SessionError('invalid_input', `会议 id 已存在: ${id}`)
      }
      throw e
    }
    return this.getSession(id)!
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined
    return r ? toSession(r) : undefined
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at ASC, id ASC`)
      .all() as Row[]
    return rows.map(toSession)
  }

  closeSession(id: string): Session {
    const cur = this.getSession(id)
    if (!cur) throw new SessionError('not_found', `会议不存在: ${id}`)
    if (cur.status === 'closed') return cur // 幂等
    this.db
      .prepare(`UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(now(), id)
    return this.getSession(id)!
  }

  renameSession(id: string, title: string): Session {
    const current = this.getSession(id)
    if (!current) throw new SessionError('not_found', `会议不存在: ${id}`)
    const normalized = title.trim()
    if (!normalized || [...normalized].length > 120) {
      throw new SessionError('invalid_input', '会议标题需为 1–120 个字符')
    }
    if (normalized === current.title) return current
    this.db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(normalized, now(), id)
    return this.getSession(id)!
  }

  join(input: JoinInput): Membership {
    const role = input.role ?? '成员'
    if (!isRole(role)) {
      throw new SessionError('invalid_role', `角色 ${JSON.stringify(role)} 不是合法的团队成员角色`)
    }
    const existing = this.db
      .prepare(`SELECT * FROM session_members WHERE session_id = ? AND principal_id = ?`)
      .get(input.sessionId, input.principalId) as Row | undefined

    if (!existing) {
      // 先查过没有旧行 → 主键 (session_id, principal_id) 不可能冲突，
      // 任何唯一约束失败都是 DRI 部分唯一索引（承旧 member.go 的推导）。
      try {
        this.db
          .prepare(
            `INSERT INTO session_members(session_id, principal_id, role, status, joined_at, left_at, duty)
             VALUES (?, ?, ?, 'active', ?, NULL, ?)`,
          )
          .run(input.sessionId, input.principalId, role, now(), input.duty ?? '')
      } catch (e) {
        mapConstraintError(e)
      }
    } else if (existing.status === 'active') {
      if (existing.role !== role) {
        // 改角色是显式操作，不该作为"加入"的副作用（承旧 ErrRoleConflict 的教训）。
        throw new SessionError(
          'role_conflict',
          `该参与者已在册，且角色不同（现 ${existing.role} ≠ 请求 ${role}）`,
        )
      }
      return toMembership(existing) // 幂等
    } else {
      // 重新加入：原行激活，不新建（主键相同会撞）。
      try {
        this.db
          .prepare(
            `UPDATE session_members
             SET status = 'active', role = ?, joined_at = ?, left_at = NULL, duty = COALESCE(?, duty)
             WHERE session_id = ? AND principal_id = ?`,
          )
          .run(role, now(), input.duty ?? null, input.sessionId, input.principalId)
      } catch (e) {
        mapConstraintError(e)
      }
    }
    const row = this.db
      .prepare(`SELECT * FROM session_members WHERE session_id = ? AND principal_id = ?`)
      .get(input.sessionId, input.principalId) as Row
    return toMembership(row)
  }

  setRole(sessionId: string, principalId: string, role: Membership['role']): Membership {
    if (!isRole(role)) {
      throw new SessionError('invalid_role', `角色 ${JSON.stringify(role)} 不是合法的团队成员角色`)
    }
    const existing = this.db
      .prepare(`SELECT * FROM session_members WHERE session_id = ? AND principal_id = ? AND status = 'active'`)
      .get(sessionId, principalId) as Row | undefined
    if (!existing) throw new SessionError('not_found', `该参与者不在册（或已离开）: ${principalId}`)
    if (existing.role === role) return toMembership(existing)
    try {
      this.db.prepare(`UPDATE session_members SET role = ? WHERE session_id = ? AND principal_id = ? AND status = 'active'`)
        .run(role, sessionId, principalId)
    } catch (e) {
      mapConstraintError(e)
    }
    const row = this.db
      .prepare(`SELECT * FROM session_members WHERE session_id = ? AND principal_id = ?`)
      .get(sessionId, principalId) as Row
    return toMembership(row)
  }

  leave(sessionId: string, principalId: string): void {
    const r = this.db
      .prepare(
        `UPDATE session_members SET status = 'left', left_at = ?
         WHERE session_id = ? AND principal_id = ? AND status = 'active'`,
      )
      .run(now(), sessionId, principalId)
    if (Number(r.changes) === 0) {
      throw new SessionError('not_found', `该参与者不在册（或已离开）: ${principalId}`)
    }
  }

  listMembers(sessionId: string, onlyActive = true): Membership[] {
    const sql = onlyActive
      ? `SELECT * FROM session_members WHERE session_id = ? AND status = 'active' ORDER BY joined_at ASC, principal_id ASC`
      : `SELECT * FROM session_members WHERE session_id = ? ORDER BY joined_at ASC, principal_id ASC`
    return (this.db.prepare(sql).all(sessionId) as Row[]).map(toMembership)
  }
}
