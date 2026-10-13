// ctx.memory 的 sqlite 实现（分层架构 L1 记忆层，2026-09-30）。
// 语义契约见 seam/space-memory 类注释。scope 三域 + weight×新近度召回 +
// LIKE 检索 + 幂等遗忘。表 DDL 唯一出处 migrations/0008_memory。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MemoryError, MemoryService } from 'space-memory'
import type { MemoryFolder, MemoryItem, MemoryListOptions, MemoryListResult, RecallOptions } from 'space-memory'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()
const SCOPE_RE = /^(session|agent):[A-Za-z0-9._-]+$/
const folderForKind = (kind: string) => kind.startsWith('cursor:')
  ? '.system/cursors'
  : kind.startsWith('history_bootstrap:')
    ? '会话历史/摘要'
    : kind.startsWith('conversation_fact:')
      ? '会话事实'
      : kind.startsWith('todo')
        ? '任务'
        : '其他'
const folderDescendantPattern = (path: string) => `${path.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`

function assertScope(scope: string): void {
  if (scope !== 'global' && !SCOPE_RE.test(scope)) {
    throw new MemoryError('bad_scope', `非法记忆 scope：${scope}（应为 'session:<id>' / 'agent:<id>' / 'global'）`)
  }
}

function toItem(r: Row): MemoryItem {
  let sourceEventIds: string[] = []
  try { sourceEventIds = JSON.parse(String(r.source_event_ids ?? '[]')) as string[] } catch { /* legacy row */ }
  const sourceEventId = (r.source_event_id as string | null) ?? null
  if (sourceEventId && !sourceEventIds.includes(sourceEventId)) sourceEventIds.unshift(sourceEventId)
  return {
    id: r.id as string,
    scope: r.scope as string,
    kind: r.kind as string,
    folderPath: String(r.folder_path ?? ''),
    text: r.text as string,
    weight: Number(r.weight),
    authorId: (r.author_id as string | null) ?? null,
    sourceEventId,
    sourceEventIds,
    invalidatedAt: (r.invalidated_at as string | null) ?? null,
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
    opts?: { weight?: number; authorId?: string | null; sourceEventId?: string | null; sourceEventIds?: string[]; folderPath?: string },
  ): Promise<MemoryItem> {
    assertScope(scope)
    if (!text.trim()) {
      throw new MemoryError('empty_text', '记忆文本为空（纯空白不写入）')
    }
    const weight = opts?.weight ?? 0.5
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new MemoryError('invalid_weight', `记忆权重必须在 [0,1]：收到 ${weight}`)
    }
    const sourceEventIds = [...new Set([...(opts?.sourceEventIds ?? []), opts?.sourceEventId].filter((id): id is string => Boolean(id)))]
    const folderPath = opts?.folderPath ?? folderForKind(kind)
    this.ensureFolderPath(scope, folderPath)
    for (const id of sourceEventIds) {
      const source = this.db.prepare('SELECT voided FROM events WHERE id = ?').get(id) as { voided: number } | undefined
      if (!source || Number(source.voided) === 1) {
        throw new MemoryError('not_found', `记忆来源事件 ${id} 不存在或已撤回`)
      }
    }
    let sourceEventId: string | null = opts?.sourceEventId ?? sourceEventIds[0] ?? null
    if (sourceEventId) {
      const existing = this.db.prepare(
        'SELECT * FROM memories WHERE scope = ? AND kind = ? AND source_event_id = ? ORDER BY invalidated_at IS NULL DESC LIMIT 1',
      ).get(scope, kind, sourceEventId) as Row | undefined
      if (existing && existing.invalidated_at == null) return this.withSources(existing)
      if (existing) sourceEventId = null // keep the invalidated record immutable; a rebuild is a new memory row.
    }
    const item: MemoryItem = {
      id: randomUUID(),
      scope,
      kind,
      folderPath,
      text,
      weight,
      authorId: opts?.authorId ?? null,
      sourceEventId,
      sourceEventIds,
      invalidatedAt: null,
      createdAt: now(),
    }
    this.db
      .prepare(
        `INSERT INTO memories(id, scope, kind, folder_path, text, weight, author_id, created_at, source_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.scope, item.kind, item.folderPath, item.text, item.weight, item.authorId, item.createdAt, item.sourceEventId)
    const link = this.db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, source_event_id) VALUES (?, ?)')
    for (const id of sourceEventIds) link.run(item.id, id)
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
        `SELECT m.*, (SELECT json_group_array(ms.source_event_id) FROM memory_sources ms WHERE ms.memory_id = m.id) AS source_event_ids, (
           m.weight * 0.7 +
           0.3 * MAX(0, MIN(1, (julianday(created_at) - (
             SELECT MIN(julianday(created_at)) FROM memories WHERE scope = ? AND invalidated_at IS NULL
           )) / MAX(1e-9, julianday('now') - (
             SELECT MIN(julianday(created_at)) FROM memories WHERE scope = ? AND invalidated_at IS NULL
           ))))
         ) AS rank_score
         FROM memories m
         WHERE m.scope = ? AND m.invalidated_at IS NULL AND m.weight >= ? ${opts?.kind ? 'AND m.kind = ?' : ''} ${opts?.folderPath ? "AND (m.folder_path = ? OR m.folder_path LIKE ? ESCAPE '\\')" : ''}
         ORDER BY rank_score DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(...[
        scope, scope, scope, minWeight,
        ...(opts?.kind ? [opts.kind] : []),
        ...(opts?.folderPath ? [opts.folderPath, folderDescendantPattern(opts.folderPath)] : []),
        limit,
      ]) as Row[]
    return rows.map(toItem)
  }

  async search(scope: string, query: string, limit = 10, folderPath?: string): Promise<MemoryItem[]> {
    assertScope(scope)
    const q = query.trim()
    if (!q) return []
    const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    return (
      this.db
        .prepare(
        `SELECT m.*, (SELECT json_group_array(ms.source_event_id) FROM memory_sources ms WHERE ms.memory_id = m.id) AS source_event_ids
           FROM memories m
           WHERE m.scope = ? AND m.invalidated_at IS NULL AND m.text LIKE ? ESCAPE '\\' ${folderPath ? "AND (m.folder_path = ? OR m.folder_path LIKE ? ESCAPE '\\')" : ''}
           ORDER BY weight DESC, created_at DESC
           LIMIT ?`,
        )
        .all(...[scope, `%${escaped}%`, ...(folderPath ? [folderPath, folderDescendantPattern(folderPath)] : []), limit]) as Row[]
    ).map(toItem)
  }

  async list(scope: string, opts: MemoryListOptions = {}): Promise<MemoryListResult> {
    assertScope(scope)
    const offset = Math.max(0, Math.floor(opts.offset ?? 0))
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)))
    const activeOnly = opts.includeInvalidated ? '' : ' AND invalidated_at IS NULL'
    const folderClause = opts.folderPath ? ' AND folder_path = ?' : ''
    const systemClause = opts.excludeSystem ? " AND folder_path NOT LIKE '.system/%'" : ''
    const args = [scope, ...(opts.folderPath ? [opts.folderPath] : [])]
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM memories WHERE scope = ?${activeOnly}${folderClause}${systemClause}`).get(...args) as { total: number }
    const items = this.db.prepare(`
      SELECT m.*, (SELECT json_group_array(ms.source_event_id) FROM memory_sources ms WHERE ms.memory_id = m.id) AS source_event_ids
      FROM memories m WHERE m.scope = ?${activeOnly}${folderClause}${systemClause}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as Row[]
    return { items: items.map(toItem), total: Number(totalRow.total) }
  }

  async listFolders(scope: string): Promise<MemoryFolder[]> {
    assertScope(scope)
    return (this.db.prepare(`
      SELECT f.path, f.name, f.parent_path,
        (SELECT COUNT(*) FROM memories m WHERE m.scope = f.scope AND m.folder_path = f.path AND m.invalidated_at IS NULL) AS item_count
      FROM memory_folders f WHERE f.scope = ? ORDER BY f.parent_path, f.name
    `).all(scope) as Row[]).map((row) => ({
      path: String(row.path), name: String(row.name), parentPath: String(row.parent_path), itemCount: Number(row.item_count ?? 0),
    }))
  }

  async createFolder(scope: string, name: string, parentPath = ''): Promise<MemoryFolder> {
    assertScope(scope)
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 80 || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '.' || cleanName === '..') {
      throw new MemoryError('bad_folder', '文件夹名称不能为空，且不能包含路径分隔符')
    }
    if (parentPath && !this.db.prepare('SELECT 1 FROM memory_folders WHERE scope = ? AND path = ?').get(scope, parentPath)) {
      throw new MemoryError('not_found', `父文件夹 ${parentPath} 不存在`)
    }
    const path = parentPath ? `${parentPath}/${cleanName}` : cleanName
    this.db.prepare('INSERT INTO memory_folders(scope, path, name, parent_path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(scope, path, cleanName, parentPath, now())
    return { path, name: cleanName, parentPath, itemCount: 0 }
  }

  async move(scope: string, id: string, folderPath: string): Promise<MemoryItem> {
    assertScope(scope)
    const row = this.db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as { scope: string } | undefined
    if (!row) throw new MemoryError('not_found', `记忆 ${id} 不存在`)
    if (row.scope !== scope) throw new MemoryError('not_found', `记忆 ${id} 不属于当前 scope`)
    if (folderPath && !this.db.prepare('SELECT 1 FROM memory_folders WHERE scope = ? AND path = ?').get(row.scope, folderPath)) {
      throw new MemoryError('not_found', `文件夹 ${folderPath} 不存在`)
    }
    this.db.prepare('UPDATE memories SET folder_path = ? WHERE id = ?').run(folderPath, id)
    const updated = this.db.prepare(`SELECT m.*,
      (SELECT json_group_array(ms.source_event_id) FROM memory_sources ms WHERE ms.memory_id = m.id) AS source_event_ids
      FROM memories m WHERE m.id = ?`).get(id) as Row
    return toItem(updated)
  }

  async forget(id: string): Promise<void> {
    // 幂等：不存在也静默返回（与"遗忘"语义一致，不炸不报 not_found）。
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
  }

  async forgetBySource(sourceEventId: string): Promise<number> {
    return (await this.invalidateBySource(sourceEventId)).length
  }

  async invalidateBySource(sourceEventId: string): Promise<MemoryItem[]> {
    const rows = this.db.prepare(`SELECT m.*,
        (SELECT json_group_array(ms.source_event_id) FROM memory_sources ms WHERE ms.memory_id = m.id) AS source_event_ids
      FROM memories m
      WHERE m.invalidated_at IS NULL AND (m.source_event_id = ? OR m.id IN (
        SELECT memory_id FROM memory_sources WHERE source_event_id = ?
      ))`).all(sourceEventId, sourceEventId) as Row[]
    if (rows.length === 0) return []
    const invalidatedAt = now()
    const update = this.db.prepare('UPDATE memories SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL')
    const result: MemoryItem[] = []
    for (const row of rows) {
      const changed = update.run(invalidatedAt, String(row.id)).changes
      if (Number(changed) > 0) result.push(toItem({ ...row, invalidated_at: invalidatedAt }))
    }
    return result
  }

  private withSources(row: Row): MemoryItem {
    const sources = this.db.prepare('SELECT source_event_id FROM memory_sources WHERE memory_id = ? ORDER BY source_event_id')
      .all(String(row.id)) as Array<{ source_event_id: string }>
    return toItem({ ...row, source_event_ids: JSON.stringify(sources.map((item) => item.source_event_id)) })
  }

  private ensureFolderPath(scope: string, path: string): void {
    if (!path) return
    let parent = ''
    for (const name of path.split('/')) {
      if (!name || name === '.' || name === '..') throw new MemoryError('bad_folder', '记忆文件夹路径无效')
      const current = parent ? `${parent}/${name}` : name
      this.db.prepare('INSERT OR IGNORE INTO memory_folders(scope, path, name, parent_path, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(scope, current, name, parent, now())
      parent = current
    }
  }
}
