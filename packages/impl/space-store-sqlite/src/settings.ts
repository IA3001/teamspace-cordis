// ctx.settings 的 sqlite 实现（运行时键值设置，2026-10-05）。
// 语义契约见 seam/space-settings 类注释：同步 KV、JSON 落库、set(undefined)
// 等价删除。表 DDL 唯一出处 migrations/0013_settings（断言 ⑧）。
//
// Sensitive settings are encrypted at rest with AES-256-GCM. The master key is
// supplied out of band through SETTINGS_ENCRYPTION_KEY and is never stored here.
import type { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { SettingsService } from 'space-settings'

const ENCRYPTED_PREFIX = 'encrypted:v1:'
const SECRET_KEY = /(?:api.?key|secret|password|token)$/i

export class SettingsEncryptionError extends Error {
  constructor(message: string) { super(message); this.name = 'SettingsEncryptionError' }
}

function encryptionKey(): Buffer {
  const configured = process.env.SETTINGS_ENCRYPTION_KEY?.trim() ?? ''
  if (!configured) throw new SettingsEncryptionError('SETTINGS_ENCRYPTION_KEY 未配置，拒绝读写明文凭据')
  const key = /^[\da-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64')
  if (key.length !== 32) throw new SettingsEncryptionError('SETTINGS_ENCRYPTION_KEY 必须是 32 字节的 Base64 或 64 位十六进制值')
  return key
}

function seal(key: string, value: unknown): string {
  const serialized = JSON.stringify(value)
  if (!SECRET_KEY.test(key) || typeof value !== 'string' || value.length === 0) return serialized
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ENCRYPTED_PREFIX + JSON.stringify({
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64'),
  })
}

function unseal(key: string, stored: string): unknown {
  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    const value = JSON.parse(stored.slice(ENCRYPTED_PREFIX.length)) as { iv: string; tag: string; data: string }
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
    } catch (error) {
      if (error instanceof SettingsEncryptionError) throw error
      throw new SettingsEncryptionError('设置凭据无法解密；请确认 SETTINGS_ENCRYPTION_KEY 与写入时一致')
    }
  }
  const parsed = JSON.parse(stored) as unknown
  if (SECRET_KEY.test(key) && typeof parsed === 'string' && parsed.length > 0) {
    // Upgrade legacy plaintext credentials on first read, without returning a
    // value that cannot be protected by the configured master key.
    const sealed = seal(key, parsed)
    return { legacyPlaintext: parsed, sealed }
  }
  return parsed
}

export class SqliteSettingsStore extends SettingsService {
  private readonly stmtGet: ReturnType<DatabaseSync['prepare']>
  private readonly stmtUpsert: ReturnType<DatabaseSync['prepare']>
  private readonly stmtDelete: ReturnType<DatabaseSync['prepare']>
  private readonly stmtAll: ReturnType<DatabaseSync['prepare']>

  constructor(
    ctx: ConstructorParameters<typeof SettingsService>[0],
    db: DatabaseSync,
  ) {
    super(ctx)
    // 语句全部在构造体内准备（不能放字段初始化器 —— ES2022 语义下字段
    // 初始化器先于构造体执行，this.db 那时还没赋值）。
    this.stmtGet = db.prepare('SELECT value FROM settings WHERE key = ?')
    this.stmtUpsert = db.prepare(
      'INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    this.stmtDelete = db.prepare('DELETE FROM settings WHERE key = ?')
    this.stmtAll = db.prepare('SELECT key, value FROM settings')
  }

  override get<T>(key: string, fallback: T): T {
    try {
      const row = this.stmtGet.get(key) as { value: string } | undefined
      if (!row) return fallback
      const value = unseal(key, row.value)
      if (value && typeof value === 'object' && 'legacyPlaintext' in value && 'sealed' in value) {
        const legacy = value as { legacyPlaintext: T; sealed: string }
        this.stmtUpsert.run(key, legacy.sealed, new Date().toISOString())
        return legacy.legacyPlaintext
      }
      return value as T
    } catch (error) {
      if (error instanceof SettingsEncryptionError) throw error
      return fallback
    }
  }

  override set(key: string, value: unknown): void {
    if (value === undefined) {
      this.stmtDelete.run(key)
      return
    }
    this.stmtUpsert.run(key, seal(key, value), new Date().toISOString())
  }

  override all(prefix?: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.stmtAll.all() as Array<{ key: string; value: string }>) {
      if (prefix && !r.key.startsWith(prefix)) continue
      try {
        out[r.key] = this.get(r.key, undefined)
      } catch (error) {
        if (error instanceof SettingsEncryptionError) throw error
        out[r.key] = r.value
      }
    }
    return out
  }
}
