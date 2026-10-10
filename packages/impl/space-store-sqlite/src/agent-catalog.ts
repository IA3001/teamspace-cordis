// SQLite implementation of the persistent, team-shared Agent catalog.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AGENT_TEMPLATES,
  AgentCatalogError,
  AgentCatalogService,
} from 'space-agent-catalog'
import type {
  AgentTemplate,
  AgentDefinition,
  AgentDefinitionInput,
  AgentDefinitionPatch,
} from 'space-agent-catalog'

type Row = Record<string, unknown>
const now = () => new Date().toISOString()

function parseList(value: unknown, label: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(String(value ?? '[]')) } catch {
    throw new AgentCatalogError('invalid_input', `${label} 必须是字符串数组`)
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new AgentCatalogError('invalid_input', `${label} 必须是非空字符串数组`)
  }
  return [...new Set(parsed.map((v: string) => v.trim()))]
}

function toDefinition(r: Row): AgentDefinition {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    promptRef: r.prompt_ref as string,
    modelRef: r.model_ref as string,
    llmProfileRef: r.llm_profile_ref as string,
    templateOrigin: r.template_id
      ? { id: r.template_id as string, version: Number(r.template_version) }
      : null,
    toolIds: parseList(r.tool_ids, 'toolIds'),
    contextSources: parseList(r.context_sources, 'contextSources'),
    memoryPolicy: r.memory_policy as string,
    speechPolicy: r.speech_policy as string,
    status: r.status as AgentDefinition['status'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function cleanInput(input: AgentDefinitionInput): AgentDefinitionInput {
  const title = String(input.title ?? '').trim()
  const description = String(input.description ?? '').trim()
  if (!title || title.length > 80) {
    throw new AgentCatalogError('invalid_input', 'Agent 名称不能为空且最多 80 个字符')
  }
  if (!description) {
    throw new AgentCatalogError('invalid_input', 'Agent 职责说明不能为空')
  }
  const templateOrigin = input.templateOrigin ?? null
  if (templateOrigin !== null && (!/^[a-z][a-z0-9-]{0,63}$/.test(templateOrigin.id) ||
    !Number.isSafeInteger(templateOrigin.version) || templateOrigin.version < 1)) {
    throw new AgentCatalogError('invalid_input', '模板来源必须包含有效模板 ID 和正整数版本')
  }
  return {
    title,
    description,
    promptRef: String(input.promptRef ?? '').trim(),
    modelRef: String(input.modelRef ?? '').trim(),
    llmProfileRef: String(input.llmProfileRef ?? '').trim(),
    toolIds: parseList(JSON.stringify(input.toolIds ?? []), 'toolIds'),
    contextSources: parseList(JSON.stringify(input.contextSources ?? ['session', 'agent-memory', 'team-kb']), 'contextSources'),
    memoryPolicy: String(input.memoryPolicy ?? 'agent').trim() || 'agent',
    speechPolicy: String(input.speechPolicy ?? 'passive').trim() || 'passive',
    templateOrigin,
  }
}

function cleanTemplate(input: Omit<AgentTemplate, 'id' | 'version' | 'teamOwned'>): Omit<AgentTemplate, 'id' | 'version' | 'teamOwned'> {
  if (!input || typeof input !== 'object' || !input.input || typeof input.input !== 'object') {
    throw new AgentCatalogError('invalid_input', '模板必须包含有效的 Agent 配置')
  }
  const title = String(input.title ?? '').trim()
  const summary = String(input.summary ?? '').trim()
  if (!title || title.length > 80 || !summary || summary.length > 240) {
    throw new AgentCatalogError('invalid_input', '模板名称和说明不能为空（最多 80 / 240 个字符）')
  }
  const { templateOrigin: _origin, ...rawInput } = input.input
  return { title, summary, input: cleanInput({ ...rawInput, templateOrigin: null }) }
}

function toTemplate(row: Row): AgentTemplate {
  const input = JSON.parse(String(row.input)) as AgentDefinitionInput
  return {
    id: row.id as string,
    version: Number(row.version),
    title: row.title as string,
    summary: row.summary as string,
    input,
    teamOwned: true,
    status: row.status as AgentTemplate['status'],
  }
}

export class SqliteAgentCatalog extends AgentCatalogService {
  constructor(ctx: ConstructorParameters<typeof AgentCatalogService>[0], private readonly db: DatabaseSync) {
    super(ctx)
  }

  create(input: AgentDefinitionInput, id = `a_${randomUUID()}`): AgentDefinition {
    const value = cleanInput(input)
    const timestamp = now()
    try {
      this.db.prepare(`
        INSERT INTO agent_definitions(
          id, title, description, prompt_ref, model_ref, llm_profile_ref, tool_ids,
          context_sources, memory_policy, speech_policy, template_id, template_version,
          status, created_at, updated_at
        ) VALUES ($id, $title, $description, $promptRef, $modelRef, $llmProfileRef, $toolIds, $contextSources, $memoryPolicy, $speechPolicy, $templateId, $templateVersion, 'active', $createdAt, $updatedAt)
      `).run({
        $id: id, $title: value.title, $description: value.description,
        $promptRef: value.promptRef, $modelRef: value.modelRef, $llmProfileRef: value.llmProfileRef ?? '',
        $toolIds: JSON.stringify(value.toolIds), $contextSources: JSON.stringify(value.contextSources),
        $memoryPolicy: value.memoryPolicy, $speechPolicy: value.speechPolicy,
        $templateId: value.templateOrigin?.id ?? '', $templateVersion: value.templateOrigin?.version ?? 0,
        $createdAt: timestamp, $updatedAt: timestamp,
      })
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) {
        throw new AgentCatalogError('duplicate_title', `已有同名 Agent「${value.title}」`)
      }
      throw e
    }
    return this.get(id)
  }

  update(id: string, patch: AgentDefinitionPatch): AgentDefinition {
    const current = this.get(id)
    if (current.status !== 'active') {
      throw new AgentCatalogError('not_found', `Agent ${id} 已归档`)
    }
    const value = cleanInput({ ...current, ...patch })
    try {
      this.db.prepare(`
        UPDATE agent_definitions SET title = $title, description = $description, prompt_ref = $promptRef,
          model_ref = $modelRef, llm_profile_ref = $llmProfileRef, tool_ids = $toolIds,
          context_sources = $contextSources, memory_policy = $memoryPolicy,
          speech_policy = $speechPolicy, updated_at = $updatedAt
        WHERE id = $id
      `).run({
        $id: id, $title: value.title, $description: value.description,
        $promptRef: value.promptRef, $modelRef: value.modelRef, $llmProfileRef: value.llmProfileRef ?? '',
        $toolIds: JSON.stringify(value.toolIds), $contextSources: JSON.stringify(value.contextSources),
        $memoryPolicy: value.memoryPolicy, $speechPolicy: value.speechPolicy, $updatedAt: now(),
      })
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) {
        throw new AgentCatalogError('duplicate_title', `已有同名 Agent「${value.title}」`)
      }
      throw e
    }
    return this.get(id)
  }

  get(id: string): AgentDefinition {
    const row = this.db.prepare(`SELECT * FROM agent_definitions WHERE id = ?`).get(id) as Row | undefined
    if (!row) throw new AgentCatalogError('not_found', `Agent ${id} 不存在`)
    return toDefinition(row)
  }

  list(includeArchived = false): AgentDefinition[] {
    const sql = includeArchived
      ? `SELECT * FROM agent_definitions ORDER BY title COLLATE NOCASE, id`
      : `SELECT * FROM agent_definitions WHERE status = 'active' ORDER BY title COLLATE NOCASE, id`
    return (this.db.prepare(sql).all() as Row[]).map(toDefinition)
  }

  archive(id: string): AgentDefinition {
    const current = this.get(id)
    if (current.status === 'active') {
      this.db.prepare(`UPDATE agent_definitions SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), id)
    }
    return this.get(id)
  }

  saveTemplate(input: Omit<AgentTemplate, 'id' | 'version' | 'teamOwned'>, id?: string): AgentTemplate {
    const value = cleanTemplate(input)
    const templateId = id || `team-${randomUUID()}`
    if (!/^team-[a-f0-9-]{36}$/.test(templateId)) {
      throw new AgentCatalogError('invalid_input', '只允许创建或更新团队自定义模板')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT MAX(version) AS version, MAX(status) AS status FROM agent_templates WHERE id = ?').get(templateId) as Row
      if (previous.status === 'archived') throw new AgentCatalogError('invalid_input', '模板已归档，请先恢复后再保存新版本')
      const version = Number(previous.version ?? 0) + 1
      this.db.prepare(`INSERT INTO agent_templates(id, version, title, summary, input, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(templateId, version, value.title, value.summary, JSON.stringify(value.input), now())
      this.db.exec('COMMIT')
      return this.getTeamTemplate(templateId)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listTemplates(includeArchived = false): AgentTemplate[] {
    const custom = this.db.prepare(`SELECT t.* FROM agent_templates t
      JOIN (SELECT id, MAX(version) AS version FROM agent_templates GROUP BY id) latest
      ON latest.id = t.id AND latest.version = t.version
      WHERE (? = 1 OR t.status = 'active') ORDER BY t.title COLLATE NOCASE, t.id`).all(Number(includeArchived)) as Row[]
    const builtins = AGENT_TEMPLATES.map((template) => ({ ...template, status: 'active' as const }))
    return [...builtins, ...custom.map(toTemplate)]
  }

  hasTemplateVersion(id: string, version: number): boolean {
    if (!Number.isSafeInteger(version) || version < 1) return false
    if (AGENT_TEMPLATES.some((template) => template.id === id && template.version === version)) return true
    return Boolean(this.db.prepare('SELECT 1 FROM agent_templates WHERE id = ? AND version = ?').get(id, version))
  }

  archiveTemplate(id: string): AgentTemplate {
    this.setTemplateStatus(id, 'archived')
    return this.getTeamTemplate(id)
  }

  restoreTemplate(id: string): AgentTemplate {
    this.setTemplateStatus(id, 'active')
    return this.getTeamTemplate(id)
  }

  private setTemplateStatus(id: string, status: 'active' | 'archived') {
    if (!/^team-[a-f0-9-]{36}$/.test(id)) throw new AgentCatalogError('invalid_input', '只支持归档或恢复团队自定义模板')
    const result = this.db.prepare('UPDATE agent_templates SET status = ? WHERE id = ?').run(status, id)
    if (!Number(result.changes)) throw new AgentCatalogError('not_found', `团队模板 ${id} 不存在`)
  }

  private getTeamTemplate(id: string): AgentTemplate {
    const row = this.db.prepare('SELECT * FROM agent_templates WHERE id = ? ORDER BY version DESC LIMIT 1').get(id) as Row | undefined
    if (!row) throw new AgentCatalogError('not_found', `团队模板 ${id} 不存在`)
    return toTemplate(row)
  }
}
