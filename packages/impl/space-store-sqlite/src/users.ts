// ctx.users 的 sqlite 实现（IM 化改造 2026-09-30）。
// 语义契约见 seam/space-identity 类注释。密码 scrypt（node:crypto，零新依赖），
// token 随机 32B hex、库表持久化（进程重启后登录态不丢）。
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { IdentityError, UserService } from 'space-identity'
import type { PublicUser, TeamRole, TokenGrant } from 'space-identity'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()
/** token 有效期：7 天（IM 日常用，过期重登）。 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** scrypt 摘要：salt(16B) + derived(64B) 的 hex 拼接。 */
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

function checkPassword(password: string, stored: string): boolean {
  const [saltHex, derivedHex] = stored.split(':')
  if (!saltHex || !derivedHex) return false
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(derivedHex, 'hex')
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

function toPublic(r: Row): PublicUser {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: (r.display_name as string) || (r.username as string),
    kind: r.kind as 'human' | 'agent',
    ...(r.kind === 'human' ? { teamRole: (r.team_role as TeamRole) || 'member' } : {}),
    createdAt: r.created_at as string,
  }
}

export class SqliteUserStore extends UserService {
  constructor(
    ctx: ConstructorParameters<typeof UserService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  async register(username: string, password: string, displayName = '', teamRole: TeamRole = 'member'): Promise<PublicUser> {
    const name = username.trim()
    if (!name || !password) {
      throw new IdentityError('invalid_input', '用户名和密码都不能为空')
    }
    if (name.length > 32 || /\s/.test(name)) {
      throw new IdentityError('invalid_input', '用户名不能含空白且不超过 32 字符')
    }
    if (teamRole !== 'dri' && teamRole !== 'member') {
      throw new IdentityError('invalid_input', '团队角色必须是 DRI 或普通成员')
    }
    const id = `u_${randomUUID().slice(0, 8)}`
    try {
      this.db
        .prepare(
          `INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
           VALUES (?, ?, ?, ?, 'human', ?, ?)`,
        )
        .run(id, name, hashPassword(password), displayName.trim() || name, now(), teamRole)
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) {
        throw new IdentityError('username_taken', `用户名 ${name} 已被占用`)
      }
      throw e
    }
    return (await this.byId(id))!
  }

  async login(username: string, password: string): Promise<TokenGrant> {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE username = ?`)
      .get(username.trim()) as Row | undefined
    if (!row || row.kind !== 'human') {
      // agent 身份与不存在都归为同一错误（不泄露账号是否存在）。
      throw new IdentityError('bad_credentials', '用户名或密码不正确')
    }
    if (!checkPassword(password, row.password_hash as string)) {
      throw new IdentityError('bad_credentials', '用户名或密码不正确')
    }
    return this.issueToken(row.id as string)
  }

  async verifyToken(token: string): Promise<PublicUser> {
    const row = this.db
      .prepare(
        `SELECT u.* FROM login_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?`,
      )
      .get(token) as Row | undefined
    if (!row) throw new IdentityError('token_unknown', '登录态无效，请重新登录')
    const expires = this.db
      .prepare(`SELECT expires_at FROM login_tokens WHERE token = ?`)
      .get(token) as { expires_at: string }
    if (new Date(expires.expires_at).getTime() < Date.now()) {
      this.db.prepare(`DELETE FROM login_tokens WHERE token = ?`).run(token)
      throw new IdentityError('token_expired', '登录已过期，请重新登录')
    }
    return toPublic(row)
  }

  async logout(token: string): Promise<void> {
    this.db.prepare(`DELETE FROM login_tokens WHERE token = ?`).run(token)
  }
  /** 注册 AI 成员身份（2026-10-07）：无凭据不可登录；id 由调用方给定
   *  （如 a_custom_*），供自定义 Agent 入会的外键引用。 */
  registerAgent(id: string, displayName: string): PublicUser {
    try {
      this.db
        .prepare(
          `INSERT INTO users(id, username, password_hash, display_name, kind, created_at)
           VALUES (?, ?, '', ?, 'agent', ?)`,
        )
        .run(id, id, displayName.trim() || id, now())
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) {
        throw new IdentityError('username_taken', `身份 ${id} 已存在`)
      }
      throw e
    }
    return { id, username: id, displayName: displayName.trim() || id, kind: 'agent', createdAt: now() } as PublicUser
  }


  async byId(id: string): Promise<PublicUser | null> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined
    return row ? toPublic(row) : null
  }

  async listHumans(): Promise<PublicUser[]> {
    return (
      this.db
        .prepare(`SELECT * FROM users WHERE kind = 'human' ORDER BY created_at ASC`)
        .all() as Row[]
    ).map(toPublic)
  }

  // ── 账号管理（admin 面，2026-10-01）────────────────────────────────────

  async listAll(): Promise<PublicUser[]> {
    // 先人类后 agent（kind ASC：'agent' < 'human'，所以倒过来 DESC），组内按创建时间。
    return (
      this.db
        .prepare(
          `SELECT * FROM users ORDER BY CASE kind WHEN 'human' THEN 0 ELSE 1 END, created_at ASC`,
        )
        .all() as Row[]
    ).map(toPublic)
  }

  async resetPassword(id: string, password: string): Promise<void> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined
    if (!row) throw new IdentityError('unknown_user', `用户 ${id} 不存在`)
    if (row.kind !== 'human') {
      throw new IdentityError('forbidden_kind', 'agent 身份没有密码，无法重置')
    }
    if (!password) throw new IdentityError('invalid_input', '密码不能为空')
    this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), id)
    // 密码改了，旧 token 一律作废（防"前主人还挂着登录态"）。
    this.db.prepare(`DELETE FROM login_tokens WHERE user_id = ?`).run(id)
  }


  async removeUser(id: string): Promise<void> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined
    if (!row) throw new IdentityError('unknown_user', `用户 ${id} 不存在`)
    if (row.kind !== 'human') {
      throw new IdentityError('forbidden_kind', 'agent 身份是系统内建的，不能删除')
    }
    // 仍挂在任何会话里（member 行未移出/未退会）就不许删，避免留下悬空成员。
    const inSession = this.db
      .prepare(`SELECT 1 FROM session_members WHERE principal_id = ? LIMIT 1`)
      .get(id)
    if (inSession) {
      throw new IdentityError('in_use', '该用户仍在会话成员中，请先将其移出所有会话再删除')
    }
    // login_tokens 无 FK 级联保险起见手动删（有些库开 FK，有些没开）。
    this.db.prepare(`DELETE FROM login_tokens WHERE user_id = ?`).run(id)
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id)
  }

  private issueToken(userId: string): TokenGrant {
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    this.db
      .prepare(`INSERT INTO login_tokens(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(token, userId, now(), expiresAt)
    return { token, userId, expiresAt }
  }
}
