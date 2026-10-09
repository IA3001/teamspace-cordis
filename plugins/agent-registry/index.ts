// agent-registry —— ctx.agents 服务实例的**唯一**提供者（P6，2026-09-29）。
//
// 谁提供谁创建：与 command-bus / ui-registry 同款 —— 本插件**零业务**，
// 只负责「让 ctx.agents 存在」；各 agent 包（会议机器人 / Coding Agent）
// 都往这一个实例入驻（铁律 4：入驻 = 向 space-agent 缝注册）。
// 机制行（P6 一次性建设，进 space-base）：此后的新 agent **不改本文件、不改
// space-base** —— 新增包 + 自带 bundle 层一行（packages/bundle/space-agent-*/）。
import type { Context } from 'cordis'
import { AGENT_KINDS, AgentError, AgentService, canTransition, isAgentKind } from 'space-agent'
import type { AgentDescriptor, AgentSnapshot, AgentStatus } from 'space-agent'
import type { AgentCatalogService, AgentDefinition } from 'space-agent-catalog'

// Cordis delays apply() until the persistent shared catalog service is available.
export const inject = ['agentCatalog']

export class AgentRegistry extends AgentService {
  // TS private（编译期私有，代理安全）—— 不用 # 私有字段（cordis 服务代理
  // 重绑 this 后品牌校验必炸，2026-09-27 实测，承 ui-registry 同款注释）。
  private readonly agents = new Map<string, AgentSnapshot>()
  private readonly catalogAgentIds = new Set<string>()
  private catalog: AgentCatalogService | null = null

  bindCatalog(catalog: AgentCatalogService): void {
    this.catalog = catalog
    this.refreshCatalog()
  }

  refreshCatalog(): void {
    if (this.catalog) this.hydrateCatalog(this.catalog)
  }

  /** Reconcile the process-local registry with active, shared definitions. */
  hydrateCatalog(catalog: AgentCatalogService): void {
    const definitions = catalog.list().filter((definition) => definition.status === 'active')
    const activeIds = new Set(definitions.map((definition) => definition.id))

    // Archived/deleted definitions disappear on reconciliation; plugin agents remain untouched.
    for (const id of this.catalogAgentIds) {
      if (activeIds.has(id)) continue
      this.agents.delete(id)
      this.catalogAgentIds.delete(id)
    }

    for (const definition of definitions) {
      const descriptor = this.fromDefinition(definition)
      const current = this.agents.get(definition.id)
      if (this.catalogAgentIds.has(definition.id) && current) {
        current.descriptor = { ...descriptor, capabilities: [...descriptor.capabilities] }
      } else {
        // A collision with a code-provided Agent remains a loud registration error.
        this.register(descriptor)
        this.catalogAgentIds.add(definition.id)
      }
    }
  }

  private fromDefinition(definition: AgentDefinition): AgentDescriptor {
    return {
      id: definition.id,
      kind: 'custom',
      title: definition.title,
      promptRef: definition.promptRef || undefined,
      capabilities: [...definition.toolIds],
      description: definition.description,
      modelRef: definition.modelRef,
      toolIds: [...definition.toolIds],
      contextSources: [...definition.contextSources],
      memoryPolicy: definition.memoryPolicy,
      speechPolicy: definition.speechPolicy,
    }
  }

  register(desc: AgentDescriptor): void {
    // 空字段校验沿用 ui-registry 对空 key 的口径（复用 not_found 码 + 明说原因）。
    if (!desc.id || !desc.id.trim()) throw new AgentError('not_found', 'agent id 不能为空')
    if (!isAgentKind(desc.kind)) {
      throw new AgentError('invalid_kind', `kind "${desc.kind}" 非法（只允许 ${AGENT_KINDS.join(' / ')}）`)
    }
    if (!desc.title || !desc.title.trim()) throw new AgentError('not_found', 'agent title 不能为空')
    if (this.agents.has(desc.id)) {
      throw new AgentError('duplicate_agent', `agent "${desc.id}" 已入驻（重名是编程错误，注册期就炸）`)
    }
    this.agents.set(desc.id, {
      // 拷贝入表：调用方后续改数组不影响注册表现场
      descriptor: { ...desc, capabilities: [...desc.capabilities] },
      status: 'idle', // 报到即待命
      since: Date.now(),
      lastHeartbeatAt: null,
    })
  }

  unregister(id: string): void {
    if (!this.agents.delete(id)) throw new AgentError('not_found', `agent "${id}" 未入驻`)
  }

  heartbeat(id: string): void {
    const snap = this.agents.get(id)
    if (!snap) throw new AgentError('not_found', `agent "${id}" 未入驻`)
    snap.lastHeartbeatAt = Date.now()
  }

  setStatus(id: string, status: AgentStatus): void {
    const snap = this.agents.get(id)
    if (!snap) throw new AgentError('not_found', `agent "${id}" 未入驻`)
    if (!canTransition(snap.status, status)) {
      throw new AgentError('invalid_transition', `agent "${id}" 不允许 ${snap.status} → ${status}（白名单见 seam STATUS_TRANSITIONS）`)
    }
    snap.status = status
    snap.since = Date.now()
  }

  get(id: string): AgentSnapshot {
    const snap = this.agents.get(id)
    if (!snap) throw new AgentError('not_found', `agent "${id}" 未入驻`)
    return snap
  }

  list(kind?: AgentDescriptor['kind']): AgentSnapshot[] {
    return [...this.agents.values()]
      .filter((s) => !kind || s.descriptor.kind === kind)
      .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id))
  }
}

export function apply(ctx: Context) {
  // Service 基类的注册动作：构造即 provide（承 command-bus / ui-registry 同款用法）。
  const registry = new AgentRegistry(ctx)
  registry.bindCatalog(ctx.agentCatalog)
}
