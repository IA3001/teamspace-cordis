// ctx.settings 的 sqlite 实现（运行时键值设置，2026-10-05）。
// 语义契约见 seam/space-settings 类注释：同步 KV、JSON 落库、set(undefined)
// 等价删除。表 DDL 唯一出处 migrations/0013_settings（断言 ⑧）。
//
// 敏感值口径：apiKey 存本表（本地单机部署可接受），但**绝不**出现在日志/
// 事件流 —— 本类零 console、零 eventLog。
import type { DatabaseSync } from 'node:sqlite'
import { SettingsService } from 'space-settings'

export class SqliteSettingsStore extends SettingsService {
  private readonly db: DatabaseSync
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
    this.db = db
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
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  override set(key: string, value: unknown): void {
    if (value === undefined) {
      this.stmtDelete.run(key)
      return
    }
    this.stmtUpsert.run(key, JSON.stringify(value), new Date().toISOString())
  }

  override all(prefix?: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const r of this.stmtAll.all() as Array<{ key: string; value: string }>) {
      if (prefix && !r.key.startsWith(prefix)) continue
      try {
        out[r.key] = JSON.parse(r.value)
      } catch {
        out[r.key] = r.value
      }
    }
    return out
  }
}
