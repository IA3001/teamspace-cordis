// SQLite implementation of the persistent, team-shared Agent catalog.
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AgentCatalogError,
  AgentCatalogService,
} from 'space-agent-catalog'
import type {
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
  return {
    title,
    description,
    promptRef: String(input.promptRef ?? '').trim(),
    modelRef: String(input.modelRef ?? '').trim(),
    toolIds: parseList(JSON.stringify(input.toolIds ?? []), 'toolIds'),
    contextSources: parseList(JSON.stringify(input.contextSources ?? ['session', 'agent-memory', 'team-kb']), 'contextSources'),
    memoryPolicy: String(input.memoryPolicy ?? 'agent').trim() || 'agent',
    speechPolicy: String(input.speechPolicy ?? 'passive').trim() || 'passive',
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
          id, title, description, prompt_ref, model_ref, tool_ids,
          context_sources, memory_policy, speech_policy, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id, value.title, value.description, value.promptRef, value.modelRef,
        JSON.stringify(value.toolIds), JSON.stringify(value.contextSources),
        value.memoryPolicy, value.speechPolicy, timestamp, timestamp,
      )
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
        UPDATE agent_definitions SET title = ?, description = ?, prompt_ref = ?, model_ref = ?,
          tool_ids = ?, context_sources = ?, memory_policy = ?, speech_policy = ?, updated_at = ?
        WHERE id = ?
      `).run(
        value.title, value.description, value.promptRef, value.modelRef,
        JSON.stringify(value.toolIds), JSON.stringify(value.contextSources),
        value.memoryPolicy, value.speechPolicy, now(), id,
      )
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
}
