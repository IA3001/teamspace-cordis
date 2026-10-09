import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AdminAuthError, AdminAuthService } from 'space-admin-auth'

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const now = () => new Date().toISOString()

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`
}

function checkPassword(password: string, encoded: string): boolean {
  const [saltHex, hashHex] = encoded.split(':')
  if (!saltHex || !hashHex) return false
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class SqliteAdminAuthStore extends AdminAuthService {
  constructor(ctx: ConstructorParameters<typeof AdminAuthService>[0], private readonly db: DatabaseSync) {
    super(ctx)
  }

  override configureBootstrap(username: string, password: string): void {
    const name = username.trim()
    if (!name || !password || name.length > 64 || password.length < 6) {
      throw new AdminAuthError('invalid_bootstrap', '后台引导账号无效；用户名必填，密码至少 6 位')
    }
    const current = this.db.prepare('SELECT username, password_hash FROM admin_accounts WHERE id = ?')
      .get('admin-root') as { username: string; password_hash: string } | undefined
    // Reapplying unchanged deployment config at process startup must preserve
    // valid sessions. Only a real credential rotation invalidates them.
    if (current?.username === name && checkPassword(password, current.password_hash)) return
    const stamp = now()
    this.db.prepare(
      `INSERT INTO admin_accounts(id, username, password_hash, created_at, updated_at)
       VALUES ('admin-root', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username=excluded.username,
         password_hash=excluded.password_hash, updated_at=excluded.updated_at`,
    ).run(name, hashPassword(password), stamp, stamp)
    // A changed bootstrap credential must invalidate existing Admin sessions.
    this.db.prepare("DELETE FROM admin_sessions WHERE admin_id = 'admin-root'").run()
  }

  override async login(username: string, password: string) {
    const row = this.db.prepare('SELECT id, username, password_hash FROM admin_accounts WHERE username = ?')
      .get(username.trim()) as { id: string; username: string; password_hash: string } | undefined
    // Keep the externally visible failure identical for unknown names and bad passwords.
    if (!row || !checkPassword(password, row.password_hash)) {
      throw new AdminAuthError('bad_credentials', '管理员用户名或密码不正确')
    }
    const token = randomBytes(32).toString('hex')
    const createdAt = now()
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    this.db.prepare('INSERT INTO admin_sessions(token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, row.id, createdAt, expiresAt)
    return { token, adminId: row.id, expiresAt }
  }

  override async verifyToken(token: string) {
    const row = this.db.prepare(
      `SELECT a.id, a.username, s.expires_at FROM admin_sessions s
       JOIN admin_accounts a ON a.id = s.admin_id WHERE s.token = ?`,
    ).get(token) as { id: string; username: string; expires_at: string } | undefined
    if (!row) throw new AdminAuthError('token_unknown', '后台登录态无效，请重新登录')
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
      throw new AdminAuthError('token_expired', '后台登录已过期，请重新登录')
    }
    return { id: row.id, username: row.username }
  }

  override async logout(token: string): Promise<void> {
    this.db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
  }
}
