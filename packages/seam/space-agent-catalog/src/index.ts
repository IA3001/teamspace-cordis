// space-agent-catalog —— persistent definitions shared by the whole Team.
//
// This catalog is separate from the process-local Agent runtime registry:
// definitions survive restarts and have no creator/owner field. Session
// membership remains explicit and is not implied by catalog availability.
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    agentCatalog: AgentCatalogService
  }
}

export type AgentDefinitionStatus = 'active' | 'archived'

/** Team-owned reusable Agent configuration. Fields are data, not plugin IDs. */
export interface AgentDefinition {
  id: string
  title: string
  description: string
  promptRef: string
  modelRef: string
  llmProfileRef: string
  toolIds: string[]
  contextSources: string[]
  memoryPolicy: string
  speechPolicy: string
  templateOrigin: AgentTemplateOrigin | null
  status: AgentDefinitionStatus
  createdAt: string
  updatedAt: string
}

export interface AgentTemplateOrigin { id: string; version: number }

export type AgentDefinitionInput = Omit<AgentDefinition, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'llmProfileRef' | 'templateOrigin'> & {
  llmProfileRef?: string
  templateOrigin?: AgentTemplateOrigin | null
}
export type AgentDefinitionPatch = Partial<Omit<AgentDefinitionInput, 'templateOrigin'>>

/** Reusable starter configuration; creating from one copies data into an Agent instance. */
export interface AgentTemplate {
  id: string
  version: number
  title: string
  summary: string
  input: AgentDefinitionInput
  teamOwned?: boolean
  status?: AgentDefinitionStatus
}

/** Generic role presets. Increment version when the default input changes; existing Agent copies stay unchanged. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'research', version: 1, title: '研究与分析', summary: '检索团队资料或网页，比较证据并给出引用。',
    input: {
      title: '研究助手', description: '检索和比较可靠资料，区分事实与推断，并为结论提供可核验引用。',
      promptRef: '', modelRef: '', toolIds: ['web.search'],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
  {
    id: 'challenge', version: 1, title: '方案挑战', summary: '主动检查方案假设、边界条件和失败路径。',
    input: {
      title: '挑战者', description: '审视讨论中的方案和结论，指出隐含假设、反例、边界条件与可能的失败路径。',
      promptRef: '', modelRef: '', toolIds: ['web.search'],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
  {
    id: 'coding', version: 1, title: '代码实现', summary: '在独立工作区内读写代码并运行受控验证。',
    input: {
      title: '编码助手', description: '分析任务，先检查相关代码，再在个人工作区内实现并运行必要验证。汇报改动和结果。',
      promptRef: '', modelRef: '', toolIds: ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute'],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
  {
    id: 'review', version: 1, title: '代码审查', summary: '优先识别缺陷、回归风险和缺失验证。',
    input: {
      title: '审查助手', description: '审查给定改动，优先报告可复现的缺陷和回归风险，并指出代码位置与验证缺口。',
      promptRef: '', modelRef: '', toolIds: ['tool.workspace.read', 'tool.code.execute'],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
  {
    id: 'testing', version: 1, title: '测试设计', summary: '围绕正常、边界和异常行为制定可执行验证。',
    input: {
      title: '测试助手', description: '为任务设计可执行验证，覆盖正常、边界和异常情况，并清楚列出通过标准。',
      promptRef: '', modelRef: '', toolIds: ['tool.workspace.read', 'tool.code.execute'],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
  {
    id: 'general', version: 1, title: '通用协作', summary: '从空白职责开始定义团队需要的 Agent。',
    input: {
      title: '', description: '', promptRef: '', modelRef: '', toolIds: [],
      contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
    },
  },
]

export type AgentCatalogErrorCode = 'not_found' | 'invalid_input' | 'duplicate_title'

export class AgentCatalogError extends Error {
  constructor(public readonly code: AgentCatalogErrorCode, message: string) {
    super(message)
    this.name = 'AgentCatalogError'
  }
}

/** Persistent team-wide Agent definitions; no personal ownership semantics. */
export abstract class AgentCatalogService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentCatalog')
  }

  abstract create(input: AgentDefinitionInput, id?: string): AgentDefinition
  abstract update(id: string, patch: AgentDefinitionPatch): AgentDefinition
  abstract get(id: string): AgentDefinition
  abstract list(includeArchived?: boolean): AgentDefinition[]
  abstract archive(id: string): AgentDefinition
  abstract saveTemplate(input: Omit<AgentTemplate, 'id' | 'version' | 'teamOwned'>, id?: string): AgentTemplate
  abstract listTemplates(includeArchived?: boolean): AgentTemplate[]
  abstract hasTemplateVersion(id: string, version: number): boolean
  abstract archiveTemplate(id: string): AgentTemplate
  abstract restoreTemplate(id: string): AgentTemplate
}
