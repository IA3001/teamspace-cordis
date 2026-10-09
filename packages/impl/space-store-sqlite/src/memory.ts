// ctx.memory 的 sqlite 实现（分层架构 L1 记忆层，2026-09-30）。
// 语义契约见 seam/space-memory 类注释。scope 三域 + weight×新近度召回 +
// LIKE 检索 + 幂等遗忘。表 DDL 唯一出处 migrations/0008_memory。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MemoryError, MemoryService } from 'space-memory'
import type { MemoryItem, RecallOptions } from 'space-memory'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()
const SCOPE_RE = /^(session|agent):[A-Za-z0-9._-]+$/

function assertScope(scope: string): void {
  if (scope !== 'global' && !SCOPE_RE.test(scope)) {
    throw new MemoryError('bad_scope', `非法记忆 scope：${scope}（应为 'session:<id>' / 'agent:<id>' / 'global'）`)
  }
}

function toItem(r: Row): MemoryItem {
  return {
    id: r.id as string,
    scope: r.scope as string,
    kind: r.kind as string,
    text: r.text as string,
    weight: Number(r.weight),
    authorId: (r.author_id as string | null) ?? null,
    createdAt: r.created_at as string,
  }
}

export class SqliteMemoryStore extends MemoryService {
  constructor(
    ctx: ConstructorParameters<typeof MemoryService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  async remember(
    scope: string,
    kind: string,
    text: string,
    opts?: { weight?: number; authorId?: string | null },
  ): Promise<MemoryItem> {
    assertScope(scope)
    if (!text.trim()) {
      throw new MemoryError('empty_text', '记忆文本为空（纯空白不写入）')
    }
    const weight = opts?.weight ?? 0.5
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new MemoryError('invalid_weight', `记忆权重必须在 [0,1]：收到 ${weight}`)
    }
    const item: MemoryItem = {
      id: randomUUID(),
      scope,
      kind,
      text,
      weight,
      authorId: opts?.authorId ?? null,
      createdAt: now(),
    }
    this.db
      .prepare(
        `INSERT INTO memories(id, scope, kind, text, weight, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.scope, item.kind, item.text, item.weight, item.authorId, item.createdAt)
    return item
  }

  async recall(scope: string, opts?: RecallOptions): Promise<MemoryItem[]> {
    assertScope(scope)
    const minWeight = opts?.minWeight ?? 0
    const limit = opts?.limit ?? 10
    // 排序口径 = 重要性×新近度：weight 为主（占 0.7），created_at 为辅（占 0.3，
    // 用 julianday 归一到 0~1 近似）；同权后到先得。
    const rows = this.db
      .prepare(
        `SELECT *, (
           weight * 0.7 +
           0.3 * MAX(0, MIN(1, (julianday(created_at) - (
             SELECT MIN(julianday(created_at)) FROM memories WHERE scope = ?
           )) / MAX(1e-9, julianday('now') - (
             SELECT MIN(julianday(created_at)) FROM memories WHERE scope = ?
           ))))
         ) AS rank_score
         FROM memories
         WHERE scope = ? AND weight >= ? ${opts?.kind ? 'AND kind = ?' : ''}
         ORDER BY rank_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...(opts?.kind ? [scope, scope, scope, minWeight, opts.kind, limit] : [scope, scope, scope, minWeight, limit])) as Row[]
    return rows.map(toItem)
  }

  async search(scope: string, query: string, limit = 10): Promise<MemoryItem[]> {
    assertScope(scope)
    const q = query.trim()
    if (!q) return []
    const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    return (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE scope = ? AND text LIKE ? ESCAPE '\\'
           ORDER BY weight DESC, created_at DESC
           LIMIT ?`,
        )
        .all(scope, `%${escaped}%`, limit) as Row[]
    ).map(toItem)
  }

  async forget(id: string): Promise<void> {
    // 幂等：不存在也静默返回（与"遗忘"语义一致，不炸不报 not_found）。
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
  }
}
