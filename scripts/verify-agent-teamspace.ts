// Focused Teamspace API checks: any Team human can manage shared definitions,
// creation does not join sessions, explicit invite is idempotent, and history
// access includes the session's complete ordered event stream.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { Context as CordisContext } from 'cordis'
import type { AgentDefinition, AgentDefinitionInput } from 'space-agent-catalog'
import { AGENT_TEMPLATES } from 'space-agent-catalog'
import { AgentError } from 'space-agent'
import { AgentRegistry, apply as applyAgentRegistry } from '../plugins/agent-registry/index.ts'
import { AgentRuntime } from '../packages/impl/space-agent-runtime/src/index.ts'
import { apply as applyAgentDispatcher } from '../plugins/agent-runtime-dispatcher/index.ts'
import { OpenAiChatLlm } from '../packages/impl/space-llm-openai/src/index.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'
import {
  agentHistoryForSession,
  apply as applyTeamspace,
  inviteAgentToSession,
  migrateLegacyAgentDefinitions,
  resolveTeamspaceApiConfig,
} from '../packages/client-ui/space-client-ui-teamspace/src/index.ts'
import { apply as applySessions, createGroupSession, removeSessionMember } from '../packages/client-ui/space-client-ui-sessions/src/index.ts'

const definitions = new Map<string, AgentDefinition>()
const teamTemplates = new Map<string, Array<{ id: string; version: number; title: string; summary: string; input: AgentDefinitionInput; teamOwned: true }>>()
const promptTemplates = new Map<string, { ref: string; title: string; body: string; updatedAt: string }>()
const memberships: Array<{ sessionId: string; principalId: string; role: string; duty?: string }> = []
const events: Array<Record<string, unknown>> = Array.from({ length: 30 }, (_, i) => ({
  id: `e${i + 1}`, seq: i + 1, sessionId: 's_open', text: `history-${i + 1}`,
}))
const sessions = [{ id: 's_open', title: 'Open session', status: 'open' }]
const settings = new Map<string, unknown>()
const joined = new Set<string>()
memberships.push({ sessionId: 's_open', principalId: 'u_b', role: '管理员', duty: '' })
joined.add('s_open:u_b')
const initialMembershipCount = memberships.length
let rpc: Record<string, (...args: any[]) => any> = {}
let sessionsRpc: Record<string, (...args: any[]) => any> = {}
let appCount = 0
let refreshCount = 0
let liveRegistry: AgentRegistry | null = null

const catalog = {
  list: () => [...definitions.values()].filter((d) => d.status === 'active'),
  get(id: string) {
    const row = definitions.get(id)
    if (!row) throw new Error('not found')
    return row
  },
  create(input: AgentDefinitionInput, id = `a_test_${definitions.size + 1}`) {
    if ([...definitions.values()].some((d) => d.title.toLowerCase() === input.title.toLowerCase() && d.status === 'active')) throw new Error('duplicate')
    const at = new Date().toISOString()
    const value: AgentDefinition = { ...input, templateOrigin: input.templateOrigin ?? null, id, status: 'active', createdAt: at, updatedAt: at }
    definitions.set(id, value)
    return value
  },
  update(id: string, patch: Partial<AgentDefinitionInput>) {
    const value = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() }
    definitions.set(id, value)
    return value
  },
  archive(id: string) {
    const value = { ...this.get(id), status: 'archived' as const }
    definitions.set(id, value)
    return value
  },
  listTemplates() {
    return [...AGENT_TEMPLATES, ...[...teamTemplates.values()].map((versions) => versions.at(-1)!) ]
  },
  hasTemplateVersion(id: string, version: number) {
    return AGENT_TEMPLATES.some((template) => template.id === id && template.version === version) ||
      Boolean(teamTemplates.get(id)?.some((template) => template.version === version))
  },
  saveTemplate(input: { title: string; summary: string; input: AgentDefinitionInput }, id?: string) {
    const templateId = id ?? `team-${randomUUID()}`
    const versions = teamTemplates.get(templateId) ?? []
    const template = { ...input, id: templateId, version: versions.length + 1, teamOwned: true as const }
    versions.push(template)
    teamTemplates.set(templateId, versions)
    return template
  },
}
const ctx = Object.assign(new Context(), {
  settings: {
    get<T>(key: string, fallback: T): T { return (settings.has(key) ? settings.get(key) : fallback) as T },
    set(key: string, value: unknown) { if (value === undefined) settings.delete(key); else settings.set(key, value) },
  },
  agentCatalog: catalog,
  prompts: {
    list: () => [...promptTemplates.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    upsert(ref: string, title: string, body: string) {
      if (!ref.trim() || !title.trim() || !body.trim()) throw new Error('ref/title/body required')
      const template = { ref: ref.trim(), title: title.trim(), body: body.trim(), updatedAt: new Date().toISOString() }
      promptTemplates.set(template.ref, template)
      return template
    },
  },
  users: {
    async verifyToken(token: string) {
      if (token === 'team-a') return { id: 'u_a', kind: 'human', isAdmin: false, username: 'a', displayName: 'Member A' }
      if (token === 'team-b') return { id: 'u_b', kind: 'human', isAdmin: false, username: 'b', displayName: 'Member B' }
      if (token === 'agent-token') return { id: 'a_bot', kind: 'agent', isAdmin: false, username: 'bot', displayName: 'Bot' }
      throw new Error('unauthorized')
    },
    registerAgent(id: string, displayName: string) { return { id, kind: 'agent', displayName } },
    async listHumans() { return [] },
    async byId(id: string) { return id === 'u_a' ? { id, displayName: 'Member A' } : undefined },
  },
  agents: {
    list: () => [...definitions.values()].map((definition) => ({ descriptor: { id: definition.id, title: definition.title } })),
    get: (id: string) => ({ descriptor: { id, title: id } }),
    refreshCatalog() { refreshCount++; liveRegistry?.refreshCatalog() },
  },
  tools: { list: () => [
    { id: 'web.search', title: '网页搜索', capabilities: ['web-search'], handler: async () => '' },
    { id: 'tool.workspace.read', title: '工作区读取', capabilities: ['workdir'], handler: async () => '' },
  ] },
  session: {
    createSession({ title }: { title: string }) {
      const session = { id: `s_created_${sessions.length}`, title, status: 'open' }
      sessions.push(session)
      return session
    },
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((s) => s.id === id),
    listMembers: (id: string) => memberships.filter((m) => m.sessionId === id && joined.has(`${id}:${m.principalId}`)),
    join(input: { sessionId: string; principalId: string; role: string; duty: string }) {
      memberships.push(input)
      joined.add(`${input.sessionId}:${input.principalId}`)
      return input
    },
    leave(sessionId: string, principalId: string) { joined.delete(`${sessionId}:${principalId}`) },
  },
  eventLog: {
    append(event: Record<string, unknown>) { events.push({ ...event, seq: events.length + 1 }); return event },
    listBySession(sessionId: string) { return events.filter((e) => e.sessionId === sessionId) },
    search: () => [], reactions: () => ({}), react: () => [], unreact: () => [],
  },
  webui: { addEntry(_entry: unknown, handlers: Record<string, (...args: any[]) => any>) {
    if (_entry && typeof _entry === 'object' && 'routes' in _entry && Array.isArray((_entry as { routes: string[] }).routes) && (_entry as { routes: string[] }).routes.includes('/teamspace')) rpc = handlers
    else sessionsRpc = handlers
  }, broadcast() {} },
  ui: { registerPanel() { appCount++ } },
  staging: { list: () => [] }, commands: { list: () => [] },
  orchestrator: { turn: () => null }, memory: { recall: async () => [] },
}) as unknown as CordisContext

async function main() {
  assert.deepEqual(resolveTeamspaceApiConfig({ APP_PORT: '8443' }), {
    publicBaseUrl: null, port: 8443,
  }, 'direct mode retains the configured API port')
  assert.deepEqual(resolveTeamspaceApiConfig({
    APP_PORT: '8080', TEAMSPACE_API_BASE_URL: 'https://team.example.com/',
  }), { publicBaseUrl: 'https://team.example.com', port: 8080 },
  'reverse-proxy mode normalizes an HTTPS origin for same-origin API routes')
  assert.throws(() => resolveTeamspaceApiConfig({ TEAMSPACE_API_BASE_URL: 'https://team.example.com/api' }),
    /只接受不含路径/, 'the configured API base cannot silently double an API path prefix')
  assert.throws(() => resolveTeamspaceApiConfig({
    NODE_ENV: 'production', TEAMSPACE_API_BASE_URL: 'http://team.example.com',
  }), /必须使用 HTTPS/, 'production API origins require TLS')
  assert.throws(() => resolveTeamspaceApiConfig({ APP_PORT: '8080x' }), /APP_PORT/, 'invalid API ports fail closed')
  const registryContext = Object.assign(new Context(), { agentCatalog: catalog }) as unknown as CordisContext
  applyAgentRegistry(registryContext)
  liveRegistry = registryContext.agents as AgentRegistry
  applyTeamspace(ctx)
  applySessions(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  const input: AgentDefinitionInput = {
    title: '研究助手', description: '检索并汇总资料', promptRef: 'prompt.research',
    modelRef: 'model.reasoning', llmProfileRef: 'ark-coding', toolIds: ['kb.search'],
    templateOrigin: { id: 'research', version: 1 },
    contextSources: ['session', 'agent-memory', 'team-kb'],
    memoryPolicy: 'agent', speechPolicy: 'passive',
  }
  const created = await rpc.createAgent('team-a', input)
  assert.equal(created.title, '研究助手')
  assert.deepEqual(created.templateOrigin, { id: 'research', version: 1 }, 'creation retains the selected starter-template version')
  assert.equal(refreshCount, 1, 'creating a definition immediately refreshes the live registry')
  assert.equal(liveRegistry.get(created.id).descriptor.title, created.title)
  assert.equal(memberships.length, initialMembershipCount, 'creating a shared definition must not auto-join any open session')
  const agentTemplates = await rpc.agentTemplates('team-a')
  assert.deepEqual(agentTemplates.map((template: { id: string }) => template.id), ['research', 'challenge', 'coding', 'review', 'testing', 'general'],
    'Team humans receive generic, reusable starter templates')
  assert.deepEqual(agentTemplates.find((template: { id: string }) => template.id === 'coding')?.input.toolIds,
    ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute'])
  assert.equal(agentTemplates.find((template: { id: string }) => template.id === 'research')?.version, 1,
    'starter templates expose an explicit version')
  assert.equal(await rpc.agentTemplates('agent-token'), null, 'Agent identities cannot manage shared Agent templates')
  const savedAgentTemplate = await rpc.saveAgentTemplate('team-a', {
    title: '发布验收助手', summary: '负责发布前检查', input,
  })
  assert.equal(savedAgentTemplate.teamOwned, true)
  assert.equal(savedAgentTemplate.version, 1)
  const revisedAgentTemplate = await rpc.saveAgentTemplate('team-b', {
    title: '发布验收助手', summary: '负责发布前检查和回滚验证', input: { ...input, toolIds: ['kb.search'] },
  }, savedAgentTemplate.id)
  assert.equal(revisedAgentTemplate.version, 2, 'any Team member can append a shared template revision')
  assert.equal((await rpc.agentTemplates('team-a')).find((template: { id: string }) => template.id === savedAgentTemplate.id)?.version, 2,
    'Team template updates are visible to every Team member')
  assert.equal(await rpc.saveAgentTemplate('agent-token', { title: 'Denied', summary: 'Denied', input }), null,
    'Agent identities cannot create or update the shared template catalog')
  assert.equal(catalog.hasTemplateVersion(savedAgentTemplate.id, 1), true, 'old template revisions remain valid Agent provenance')
  assert.match((await rpc.createAgent('team-a', { ...input, title: 'Invalid template origin', templateOrigin: { id: 'research', version: 999 } })).detail,
    /模板版本不存在/, 'creation rejects a template version that is not in the shared template catalog')
  settings.set('llm.profiles', [{ id: 'ark-coding', name: 'Ark Coding' }])
  settings.set('llm.profile.ark-coding.model', 'coding-model')
  assert.deepEqual(await rpc.llmProfiles('team-a'), [{ id: 'ark-coding', name: 'Ark Coding', model: 'coding-model' }])
  assert.equal(await rpc.llmProfiles('agent-token'), null, 'Agent identities cannot read model profile metadata')
  assert.deepEqual(await rpc.promptTemplates('team-a'), [], 'Team humans can read the shared prompt catalog')
  assert.deepEqual(await rpc.toolCatalog('team-a'), [
    { id: 'web.search', title: '网页搜索', capabilities: ['web-search'] },
    { id: 'tool.workspace.read', title: '工作区读取', capabilities: ['workdir'] },
  ], 'Team humans see only serializable metadata for registered tools')
  assert.equal(await rpc.toolCatalog('agent-token'), null, 'Agent identities cannot manage shared Agent tool settings')
  const savedPrompt = await rpc.savePromptTemplate('team-b', 'prompt.research', 'Research assistant', 'Compare sources and cite evidence.')
  assert.equal(savedPrompt.template.ref, input.promptRef)
  assert.equal((await rpc.promptTemplates('team-a'))[0]?.body, 'Compare sources and cite evidence.',
    'prompt edits are shared across Team accounts')
  assert.equal(await rpc.savePromptTemplate('agent-token', 'prompt.private', 'Private', 'Denied'), null,
    'Agent identities cannot administer the Team prompt catalog')
  await rpc.updateAgent('team-b', created.id, { description: '检索、比较并汇总资料' })
  assert.equal(refreshCount, 2, 'updating a definition immediately refreshes the live registry')
  assert.equal(liveRegistry.get(created.id).descriptor.description, '检索、比较并汇总资料')
  assert.equal((await rpc.agentDefinitions('team-b')).length, 1, 'another Team human sees the shared definition')
  const fromTeamTemplate = await rpc.createAgent('team-b', {
    ...input, title: '模板创建 Agent', templateOrigin: { id: savedAgentTemplate.id, version: 1 },
  })
  assert.deepEqual(fromTeamTemplate.templateOrigin, { id: savedAgentTemplate.id, version: 1 },
    'new Agents retain the exact custom template revision they copied')
  assert.equal(await rpc.createAgent('agent-token', { ...input, title: 'Agent token must fail' }), null, 'Agent tokens cannot manage catalog')
  assert.deepEqual(await rpc.apiConfig('team-a'), { publicBaseUrl: null, port: Number(process.env.APP_PORT ?? 8080) },
    'authenticated Team users receive the deployment API mapping')
  assert.equal(await rpc.apiConfig('invalid-token'), null, 'unauthenticated callers cannot read API deployment settings')

  assert.deepEqual((await rpc.sessions('team-b')).map((session: { id: string }) => session.id), ['s_open'],
    'session lists include only sessions the authenticated human has joined')
  assert.deepEqual(await rpc.sessions('team-a'), [], 'a Team human cannot enumerate sessions they were not invited to')
  assert.equal(await rpc.events('team-a', 's_open'), null, 'non-members cannot read session history by guessing its ID')
  assert.equal(await rpc.event('team-a', 's_open', 'e1'), null, 'non-members cannot fetch event bodies from live push pointers')
  assert.equal(await rpc.search('team-a', 's_open', 'history'), null, 'non-members cannot search a private session')
  assert.equal(await rpc.members('team-a', 's_open'), null, 'non-members cannot enumerate a private session roster')
  assert.equal(await rpc.staging('team-a', 's_open'), null, 'non-members cannot read a private draft queue')
  assert.equal(await rpc.turn('team-a', 's_open'), null, 'non-members cannot inspect private orchestration state')
  assert.equal(await rpc.memories('team-a', 's_open'), null, 'non-members cannot inspect session memory')
  assert.equal(await rpc.todos('team-a', 's_open'), null, 'non-members cannot inspect session tasks')
  assert.equal(await rpc.reactions('team-a', 's_open'), null, 'non-members cannot inspect session reactions')
  assert.equal((await rpc.events('team-b', 's_open')).length, 30, 'active session members can read full history')
  assert.equal(await rpc.inviteAgent('team-a', 's_open', 'a_other'), null, 'non-members cannot invite Agents into private sessions')
  assert.equal(await rpc.agentHistory('team-a', 's_open', 'a_other'), null, 'non-members cannot inspect Agent history')
  assert.deepEqual(await sessionsRpc.sessions('team-a'), [], 'the session navigation API also filters by membership')
  assert.deepEqual((await sessionsRpc.sessions('team-b')).map((session: { id: string }) => session.id), ['s_open'])
  assert.equal(await sessionsRpc.members('team-a', 's_open'), null, 'non-members cannot inspect a session roster')

  const invited = await rpc.inviteAgent('team-b', 's_open', created.id)
  assert.equal(invited.ok, true)
  assert.equal(memberships.length, initialMembershipCount + 1)
  assert.equal((events.at(-1)?.text as string).includes('完整历史'), true)
  const history = await rpc.agentHistory('team-b', 's_open', created.id)
  assert.equal(history.length, 31, 'invited Agent receives all 30 earlier events plus invitation event')
  assert.equal(history[0]?.text, 'history-1', 'history is not truncated to recent messages')
  const duplicateInvite = await rpc.inviteAgent('team-b', 's_open', created.id)
  assert.equal(duplicateInvite.joined, false)
  assert.equal(events.length, 31, 'repeat invitation does not duplicate membership event')
  ctx.eventLog.append({
    id: 'private-tool-trace', sessionId: 's_open', authorId: null, authorKind: 'system', kind: 'system',
    text: 'human-only tool activity', toolCalls: [{ name: 'web.search', args: 'query', result: 'trace' }],
  })
  assert.equal(agentHistoryForSession(ctx, 's_open', created.id).some((event) => event.id === 'private-tool-trace'), false,
    'history provided for Agent initialization excludes human-only tool activity')

  const legacyId = 'a_custom_1_old'
  settings.set('agent.custom', [{ id: legacyId, title: '旧 Agent', roleLabel: '旧职责', promptRef: 'prompt.old' }])
  const legacyMembership = { sessionId: 's_open', principalId: legacyId, role: '成员', duty: '旧 Agent' }
  memberships.push(legacyMembership)
  joined.add(`s_open:${legacyId}`)
  const migrated = await migrateLegacyAgentDefinitions(ctx)
  assert.equal(migrated, 1)
  assert.equal(catalog.get(legacyId).description, '旧职责')
  assert.equal(liveRegistry.get(legacyId).descriptor.title, '旧 Agent', 'legacy migration refreshes the live runtime registry')
  assert.equal(settings.has('agent.custom'), false, 'legacy settings are retired after successful import')
  assert.equal(joined.has(`s_open:${legacyId}`), false, 'legacy auto-joined Agent is returned to explicit invitation semantics')
  assert.equal(agentHistoryForSession(ctx, 's_open', created.id).length, 31)

  const removed = await removeSessionMember(ctx, 's_open', created.id, 'u_a', 'Member A')
  assert.equal(removed.some((m: { principalId: string }) => m.principalId === created.id), false)
  assert.equal(joined.has(`s_open:${created.id}`), false, 'removal marks the Agent membership inactive')
  assert.match(events.at(-1)?.text as string, /Member A（u_a）将 研究助手（.*）移出会话/,
    'removal timeline event records the operator and removed Agent')

  const rosterRows = await sessionsRpc.agentRoster('team-a')
  assert.ok(rosterRows.some((row: { id: string }) => row.id === created.id),
    'the session creation roster includes Team-created Agents')
  assert.deepEqual(await sessionsRpc.agentRoster('agent-token'), [], 'Agent identities cannot query the Team invite roster')
  const createdSession = createGroupSession(ctx, {
    id: 'u_a', username: 'a', displayName: 'Member A', kind: 'human', isAdmin: false,
  }, '新建验收会话', ['u_b'], [created.id])
  assert.ok(memberships.some((member) => member.sessionId === createdSession.id && member.principalId === created.id),
    'a selected custom Agent joins the new session through the common registry')
  const creationEvent = events.find((event) => event.sessionId === createdSession.id)
  assert.match(creationEvent?.text as string, new RegExp(`Member A 创建；初始成员：u_a、${created.id}、u_b`))
  assert.match(creationEvent?.text as string, /读取完整会话历史/)

  const registry = liveRegistry!
  const hydrated = registry.get(created.id).descriptor as unknown as {
    title: string; promptRef?: string; toolIds: string[]; contextSources: string[]; modelRef: string; description?: string; capabilities: readonly string[]
  }
  assert.equal(hydrated.title, '研究助手', 'startup hydration preserves the shared title')
  assert.equal(hydrated.promptRef, 'prompt.research', 'startup hydration preserves the prompt reference')
  assert.deepEqual(hydrated.toolIds, ['kb.search'], 'startup hydration retains tool metadata')
  assert.deepEqual(hydrated.contextSources, ['session', 'agent-memory', 'team-kb'])
  assert.equal(hydrated.modelRef, 'model.reasoning')
  assert.equal(hydrated.llmProfileRef, 'ark-coding')
  assert.ok(hydrated.capabilities.includes('kb.search'))

  const workdirRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-verify-'))
  let llmMessages: Array<{ role: string; content: string }> = []
  let llmOptions: { model?: string; profileRef?: string } | undefined
  let toolInvocations = 0
  let toolGraphMode = false
  let toolGraphStep = 0
  const runtimeCtx = registryContext as CordisContext & Record<string, any>
  Object.assign(runtimeCtx, {
    settings: { get: (_key: string, fallback: string) => fallback || 'global-model' },
    prompts: { get: (ref: string) => ({ title: `placeholder:${ref}`, body: '【占位提示词】待补充正文' }) },
    llm: {
      configured: true,
      configuredFor: () => true,
      async chat(messages: typeof llmMessages, options?: typeof llmOptions) {
        llmMessages = [...messages]
        llmOptions = options
        if (toolGraphMode && toolGraphStep++ === 0) {
          return JSON.stringify({ toolCalls: [{ toolId: 'kb.search', args: { query: 'design' } }] })
        }
        if (toolGraphMode) { toolGraphMode = false; return JSON.stringify({ final: 'Graph answer with a cited result.' }) }
        return 'generic-agent-result'
      },
    },
    tools: {
      list() { return [{ id: 'kb.search', title: 'Knowledge search', description: 'args: {query}', capabilities: ['search'] }] },
      async invoke(toolId: string, _args: string, invoker: { id: string; sessionId?: string }) {
        toolInvocations++
        assert.equal(toolId, 'kb.search')
        assert.equal(invoker.id, created.id)
        return { toolId, ok: true, output: 'knowledge snippet', costMs: 2 }
      },
    },
    context: {
      async assemble(sessionId: string, options: { agentId?: string }) {
        assert.equal(sessionId, 's_open')
        assert.equal(options.agentId, created.id)
        return {
          system: 'system-context',
          history: [{ id: 'evt_history', sourceEventIds: [], kind: 'message', authorKind: 'human', text: '历史决策：采用 SQLite', voided: false }],
          memories: [{ sourceEventId: 'e12', sourceEventIds: ['e12'], text: '用户希望优先本地部署' }],
          retrieval: [
            { source: 'kb', id: 'kb-1', title: '部署指南', documentId: 'doc-1', sourceEventIds: [], text: '部署指南片段' },
            { source: 'event', id: 'evt_retrieved', title: '会话消息 #3', sourceEventIds: ['evt_retrieved'], text: '相关讨论片段' },
          ],
        }
      },
    },
    eventLog: ctx.eventLog,
  })
  new LocalWorkdirService(runtimeCtx, workdirRoot)
  const runtime = new AgentRuntime(runtimeCtx)
  Object.assign(runtimeCtx, { agentRuntime: runtime })
  const receipt = await runtime.perform(created.id, '研究现有方案')
  assert.equal(receipt.promptRef, 'prompt.research')
  assert.equal(receipt.promptTitle, 'placeholder:prompt.research')
  assert.equal(receipt.model, 'model.reasoning')
  assert.equal(llmOptions?.model, 'model.reasoning', 'modelRef overrides the shared default per call')
  assert.match(llmMessages[0]?.content ?? '', /研究助手/)
  assert.match(llmMessages[0]?.content ?? '', /检索、比较并汇总资料/)
  const citedReceipt = await runtime.perform(created.id, '根据讨论给出方案', { sessionId: 's_open' })
  assert.match(llmMessages[0]?.content ?? '', /来源事件/)
  assert.match(llmMessages[0]?.content ?? '', /引用规则/)
  assert.match(llmMessages[0]?.content ?? '', /e12/)
  assert.match(llmMessages[0]?.content ?? '', /kb:kb-1/)
  assert.ok(llmMessages.some((message) => message.content.includes('历史决策：采用 SQLite')))
  assert.deepEqual(new Set(citedReceipt.sourceEventIds), new Set(['evt_history', 'evt_retrieved', 'e12']),
    'runtime provenance includes history, retrieved events, and source events for recalled memory')
  assert.match(citedReceipt.receipt, /generic-agent-result/,
    'the final model answer is delivered in the chat receipt, not only saved as a workspace artifact')
  assert.match(citedReceipt.receipt, /参考来源（本轮检索命中）/,
    'the delivered final answer retains its verified citations')
  const citedArtifact = readFileSync(join(citedReceipt.root, citedReceipt.files.at(-1)!), 'utf8')
  assert.match(citedArtifact, /参考来源（本轮检索命中）/)
  assert.match(citedArtifact, /部署指南/)
  let delivered: { sessionId: string; target: string; text: string } | null = null
  Object.assign(runtimeCtx, {
    orchestrator: {
      reportAgentResult(sessionId: string, target: string, text: string) { delivered = { sessionId, target, text } },
    },
  })
  applyAgentDispatcher(runtimeCtx)
  runtimeCtx.emit('orchestrator/delegate', {
    sessionId: 's_open', eventId: 'delegate-1', target: created.title, instruction: '分析本会话的决策背景',
  })
  for (let i = 0; i < 50 && !delivered; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(delivered?.sessionId, 's_open')
  assert.equal(delivered?.target, created.title)
  assert.match(delivered?.text ?? '', /【工作区】/)
  assert.ok(llmMessages.some((message) => message.content.includes('分析本会话的决策背景')))
  assert.equal(toolInvocations, 0, 'the shared runtime does not invoke tools unless the model requests one')
  toolGraphMode = true
  const toolReceipt = await runtime.perform(created.id, '检索设计资料', { sessionId: 's_open' })
  assert.equal(llmOptions?.profileRef, 'ark-coding', 'shared Agent selects its configured provider profile')
  assert.equal(toolInvocations, 1, 'LangGraph executes only tools enabled in the Agent definition')
  assert.equal(toolReceipt.toolResults?.[0]?.ok, true)
  assert.match(readFileSync(join(toolReceipt.root, toolReceipt.files.at(-1)!), 'utf8'), /Graph answer with a cited result/)
  assert.ok((events.at(-1)?.toolCalls as unknown[] | undefined)?.length, 'tool execution leaves a human-visible activity event')
  rmSync(workdirRoot, { recursive: true, force: true })

  const originalFetch = globalThis.fetch
  let requestedModel = ''
  try {
    globalThis.fetch = async (_input, init) => {
      requestedModel = String((JSON.parse(String(init?.body)) as { model?: string }).model ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const llm = new OpenAiChatLlm(new Context(), { apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'global-default' })
    await llm.chat([{ role: 'user', content: 'test' }], { model: 'model.reasoning' })
    assert.equal(requestedModel, 'model.reasoning', 'OpenAI-compatible adapter sends the per-Agent modelRef')
  } finally {
    globalThis.fetch = originalFetch
  }

  await rpc.archiveAgent('team-a', created.id)
  assert.equal(refreshCount, 5, 'creating from a shared template and archiving refresh the live registry')
  assert.throws(() => registry.get(created.id), (error) => error instanceof AgentError && error.code === 'not_found', 'reconciliation removes archived catalog entries')
  console.log(`✓ Teamspace Agent API, explicit invite, full history, and legacy migration passed (${appCount} panels registered)`)
}

await main()
