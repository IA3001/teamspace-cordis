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
import { AgentExecutionFailureError } from 'space-agent-runtime'
import { eventCitations, visibleAgentReply } from '../packages/client-ui/space-client-ui-shared/client/md.ts'
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
const legacyAnswer = '## 最终回复\n\n已完成。\n\n参考来源（本轮检索命中）：\n- 【来源:kb:legacy-doc】旧版知识库资料\n- 【来源:event:legacy-event】会话消息 #6'
assert.equal(visibleAgentReply(legacyAnswer), '已完成。', 'legacy citation Markdown is removed from displayed answer content')
assert.equal(visibleAgentReply('<|DSML |> calls> <|DSML |> invoke name="tool.code.execute">secret code</|DSML |> </|DSML |>'),
  '（检测到工具调用内容，已收起；请查看工作记录）', 'raw DSML tool calls never render as a user-facing Agent answer')
assert.equal(visibleAgentReply('<| | DSML | | calls><| | DSML | | invoke name="toolCalls">[{"toolId":"tool.code.execute","args":{"code":"secret"}}]</| | DSML | |>'),
  '（检测到工具调用内容，已收起；请查看工作记录）', 'provider-specific malformed DSML envelopes are hidden after persistence')
assert.equal(visibleAgentReply('<| | DSML |'),
  '（正在处理工具调用，请查看工作记录）', 'partial DSML prefixes are hidden in live progress bubbles')
assert.equal(visibleAgentReply('{"toolCalls":[{"toolId":"tool.code.execute","args":{"code":"secret"}}]}'),
  '（检测到工具调用内容，已收起；请查看工作记录）', 'raw JSON tool envelopes never render as a user-facing Agent answer')
assert.deepEqual(eventCitations({ text: legacyAnswer }).map(({ source, id }) => `${source}:${id}`),
  ['kb:legacy-doc', 'event:legacy-event'], 'legacy citations are lifted into the system citation module')
const teamTemplates = new Map<string, Array<{ id: string; version: number; title: string; summary: string; input: AgentDefinitionInput; teamOwned: true; status: 'active' | 'archived' }>>()
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
  delete(id: string) {
    const value = this.get(id)
    definitions.delete(id)
    return value
  },
  listTemplates(includeArchived = false) {
    return [...AGENT_TEMPLATES, ...[...teamTemplates.values()].map((versions) => versions.at(-1)!) ]
      .filter((template) => includeArchived || template.status !== 'archived')
  },
  archiveTemplate(id: string) {
    const versions = teamTemplates.get(id)
    if (!versions) throw new Error('not found')
    for (const version of versions) version.status = 'archived'
    return versions.at(-1)!
  },
  restoreTemplate(id: string) {
    const versions = teamTemplates.get(id)
    if (!versions) throw new Error('not found')
    for (const version of versions) version.status = 'active'
    return versions.at(-1)!
  },
  hasTemplateVersion(id: string, version: number) {
    return AGENT_TEMPLATES.some((template) => template.id === id && template.version === version) ||
      Boolean(teamTemplates.get(id)?.some((template) => template.version === version))
  },
  saveTemplate(input: { title: string; summary: string; input: AgentDefinitionInput }, id?: string) {
    const templateId = id ?? `team-${randomUUID()}`
    const versions = teamTemplates.get(templateId) ?? []
    if (versions.at(-1)?.status === 'archived') throw new Error('已归档模板不能追加版本')
    const template = { ...input, id: templateId, version: versions.length + 1, teamOwned: true as const, status: 'active' as const }
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
  agentCatalog: catalog,
  agentInbox: { async cursor() { return 33 }, processing: () => [], activeSessionId: () => null },
  agentRuntime: { listActiveProgress: () => [] },
  workdir: { async browse() { return { exists: false, entries: [] } } },
  sessionWork: { state: () => ({ activeSessionId: null, queue: [] }) },
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
    llmProfileRef: 'ark-coding', toolIds: ['kb.search'],
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
    ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute', 'tool.session.todos', 'tool.session.history-search'])
  assert.equal(agentTemplates.find((template: { id: string }) => template.id === 'coding')?.version, 3,
    'the coding starter template increments when its default tool set changes')
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
  assert.equal((await rpc.archiveAgentTemplate('team-a', savedAgentTemplate.id)).status, 'archived')
  assert.equal((await rpc.agentTemplates('team-b')).some((template: { id: string }) => template.id === savedAgentTemplate.id), false,
    'archived templates are hidden from the default Team picker')
  assert.equal((await rpc.agentTemplates('team-b', true)).find((template: { id: string }) => template.id === savedAgentTemplate.id)?.status, 'archived',
    'Team members can reveal archived templates to restore them')
  assert.equal(await rpc.archiveAgentTemplate('agent-token', savedAgentTemplate.id), null,
    'Agent identities cannot archive shared templates')
  assert.equal((await rpc.restoreAgentTemplate('team-b', savedAgentTemplate.id)).status, 'active',
    'any Team human can restore a shared template')
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
  assert.equal((events.at(-1)?.text as string).includes('按顺序进入处理队列'), true,
    'invited Agent history is presented as ordered inbox work')
  assert.equal((events.at(-1)?.text as string).startsWith('【Agent 历史同步】'), true,
    'Agent invitations carry a private inbox bootstrap marker')
  assert.deepEqual(events.at(-1)?.mentions, [created.id], 'the onboarding trigger targets only the invited Agent')
  const history = await rpc.agentHistory('team-b', 's_open', created.id)
  assert.equal(history.length, 31, 'invited Agent receives all 30 earlier events plus invitation event')
  assert.equal(history[0]?.text, 'history-1', 'history is not truncated to recent messages')
  const duplicateInvite = await rpc.inviteAgent('team-b', 's_open', created.id)
  assert.equal(duplicateInvite.joined, false)
  assert.equal(events.length, 31, 'repeat invitation does not duplicate membership event')
  ctx.eventLog.append({ id: 'trace-source', sessionId: 's_open', seq: 32, ts: new Date().toISOString(),
    authorId: 'u_b', authorKind: 'human', kind: 'message', text: '请检查这个任务', mentions: [], toolCalls: [],
    replyMode: '', sourceEventId: null, sourceEventIds: [], voided: false })
  ctx.eventLog.append({ id: 'trace-answer', sessionId: 's_open', seq: 33, ts: new Date().toISOString(),
    authorId: created.id, authorKind: 'agent', kind: 'message', text: '检查完成。', mentions: [], replyMode: '',
    toolCalls: [{ name: 'agent.worklog', args: JSON.stringify([
      { label: '整理上下文', at: new Date().toISOString(), kind: 'phase', detail: '读取相关消息' },
      { label: '调用工具：网页搜索', at: new Date().toISOString(), kind: 'tool', status: 'success',
        inputSummary: 'query=安全 API', resultSummary: 'Authorization: Bearer abcdefghijklmnop' },
    ]) }], sourceEventId: 'trace-source', sourceEventIds: ['trace-source'], voided: false })
  ctx.eventLog.append({ id: 'trace-inbox', sessionId: 's_open', seq: 34, ts: new Date().toISOString(),
    authorId: null, authorKind: 'system', kind: 'system', text: 'Agent 后台处理记录', mentions: [], replyMode: '',
    toolCalls: [{ name: 'agent.inbox.trace', args: JSON.stringify({ agentId: created.id, sourceEventId: 'trace-source',
      sourceSeq: 32, status: 'success', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      steps: [{ label: '长期记忆处理', at: new Date().toISOString(), status: 'success', detail: '模型分析完成，无记忆写入。' }] }) }],
    sourceEventId: 'trace-source', sourceEventIds: ['trace-source'], voided: false })
  const workspaceOverview = await rpc.agentWorkspaceOverview('team-b')
  const overviewInbox = workspaceOverview.inboxes.find((item: { agentId: string }) => item.agentId === created.id)
  const recentSource = overviewInbox.recent.find((item: { eventId: string }) => item.eventId === 'trace-source')
  assert.equal(recentSource.status, 'replied', 'recent summary shows this Agent actual answer, not just cursor completion')
  assert.equal(recentSource.result, '检查完成。')
  assert.equal(overviewInbox.recent.length <= 8, true, 'overview payload stays bounded per Agent')
  assert.equal(overviewInbox.recent.every((item: { status: string }) => item.status !== 'replied' || item.eventId === 'trace-source'), true,
    'unrelated scanned messages are never reported as answered')
  assert.equal(await rpc.agentWorkspaceOverview('agent-token'), null, 'Agent token cannot read team workspace overview')
  const savedEventCount = events.length
  const savedCursor = ctx.agentInbox.cursor
  ctx.agentInbox.cursor = async () => 100
  for (let index = 0; index < 9; index++) ctx.eventLog.append({ id: `recent-new-${index}`, sessionId: 's_open', seq: 35 + index,
    ts: '2026-01-01T00:00:00.000Z', authorId: 'u_b', authorKind: 'human', kind: 'message', text: `new-${index}`,
    mentions: [], toolCalls: [], replyMode: '', sourceEventId: null, sourceEventIds: [], voided: false })
  ctx.eventLog.append({ id: 'other-agent-answer', sessionId: 's_open', seq: 44, ts: new Date().toISOString(),
    authorId: 'a_other', authorKind: 'agent', kind: 'message', text: '别的 Agent 的回答', mentions: [], toolCalls: [],
    replyMode: '', sourceEventId: 'recent-new-0', sourceEventIds: [], voided: false })
  const delayedOverview = await rpc.agentWorkspaceOverview('team-b')
  const delayedRecent = delayedOverview.inboxes.find((item: { agentId: string }) => item.agentId === created.id).recent
  assert.equal(delayedRecent.length, 8)
  assert.equal(delayedRecent.some((item: { eventId: string }) => item.eventId === 'trace-source'), true,
    'older source with a recent answer remains visible after nine newer messages')
  assert.equal(delayedRecent.some((item: { result: string }) => item.result.includes('别的 Agent')), false,
    'another Agent answer is not attributed to selected Agent')
  const crossAgentHistory = await rpc.agentWorkspaceHistory('team-b', created.id, 's_open', 1, 50)
  const crossAgentSource = crossAgentHistory.items.find((item: { id: string }) => item.id === 'recent-new-0')
  assert.deepEqual(crossAgentSource.executions, [],
    'an Agent workspace history never displays another Agent reply as the selected Agent execution')
  ctx.agentInbox.cursor = savedCursor
  events.splice(savedEventCount)

  assert.doesNotThrow(() => catalog.get(created.id))
  assert.equal(ctx.session.listMembers('s_open', true).some((member) => member.principalId === created.id), true)
  const tracedHistory = await rpc.agentWorkspaceHistory('team-b', created.id, 's_open', 1, 50)
  const tracedMessage = tracedHistory.items.find((event: { id: string }) => event.id === 'trace-source')
  assert.equal(tracedMessage.executions[0].text, '检查完成。', 'workspace history links an Agent answer to its source message')
  assert.equal(tracedMessage.executions[0].worklog.length, 2, 'workspace history exposes saved execution and tool steps')
  assert.equal(tracedHistory.items.some((event: { id: string }) => event.id === 'trace-answer'), false,
    'an Agent answer linked to a visible trigger is nested once, not repeated as a second history row')
  assert.equal(tracedHistory.scannedTotal, tracedHistory.total + 1,
    'history distinguishes scanned event count from grouped trigger rows')
  assert.match(tracedMessage.executions[0].worklog[1].resultSummary, /Bearer \[REDACTED\]/,
    'workspace execution details redact credentials before returning them')
  assert.equal(tracedMessage.inboxTrace.steps[0].label, '长期记忆处理',
    'workspace history returns the durable inbox processing chronology linked to its source message')
  const visibleTrace = (await rpc.events('team-b', 's_open')).find((event: { id: string }) => event.id === 'trace-inbox')
  assert.match(visibleTrace.text, new RegExp(`${created.title} \\(${created.id}\\).*#32`),
    'chat history names the exact Agent and source message for a background trace')
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
  assert.equal(agentHistoryForSession(ctx, 's_open', created.id).length, 33)

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
    title: string; promptRef?: string; toolIds: string[]; contextSources: string[]; description?: string; capabilities: readonly string[]
  }
  assert.equal(hydrated.title, '研究助手', 'startup hydration preserves the shared title')
  assert.equal(hydrated.promptRef, 'prompt.research', 'startup hydration preserves the prompt reference')
  assert.deepEqual(hydrated.toolIds, ['kb.search'], 'startup hydration retains tool metadata')
  assert.deepEqual(hydrated.contextSources, ['session', 'agent-memory', 'team-kb'])
  assert.equal(hydrated.llmProfileRef, 'ark-coding')
  assert.ok(hydrated.capabilities.includes('kb.search'))

  const workdirRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-verify-'))
  let llmMessages: Array<{ role: string; content: string }> = []
  let llmOptions: { model?: string; profileRef?: string; onUsage?: (usage: { inputTokens?: number; cachedInputTokens?: number; durationMs: number }) => void } | undefined
  let toolInvocations = 0
  let toolGraphMode = false
  let toolGraphStep = 0
  let failNextLlmCall = false
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
        if (failNextLlmCall) throw new Error('LLM 请求失败：fetch failed')
        if (toolGraphMode && toolGraphStep++ === 0) {
          return JSON.stringify({ toolCalls: [{ toolId: 'kb.search', args: { query: 'design' } }] })
        }
        if (toolGraphMode) { toolGraphMode = false; return JSON.stringify({ final: 'Graph answer with a cited result.' }) }
        options?.onUsage?.({ inputTokens: 2000, cachedInputTokens: 1024, durationMs: 5 })
        return 'generic-agent-result 【来源:kb:kb-1】 【来源:event:evt_retrieved】'
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
    session: ctx.session,
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
  assert.equal(receipt.model, 'global-model', 'Agents report the model configured on their selected provider')
  assert.equal(llmOptions?.model, undefined, 'Agent calls never override the selected provider model')
  assert.match(llmMessages[0]?.content ?? '', /研究助手/)
  assert.match(llmMessages[0]?.content ?? '', /检索、比较并汇总资料/)
  const citedReceipt = await runtime.perform(created.id, '根据讨论给出方案', { sessionId: 's_open' })
  const liveContext = llmMessages.at(-2)?.content ?? ''
  assert.match(liveContext, /来源事件/)
  assert.doesNotMatch(llmMessages[0]?.content ?? '', /e12|kb:kb-1/, 'volatile source IDs must not enter the stable prefix')
  assert.match(llmMessages[0]?.content ?? '', /引用规则/)
  assert.match(liveContext, /e12/)
  assert.match(liveContext, /kb:kb-1/)
  assert.ok(llmMessages.some((message) => message.content.includes('历史决策：采用 SQLite')))
  assert.deepEqual(new Set(citedReceipt.sourceEventIds), new Set(['evt_history', 'evt_retrieved', 'e12']),
    'runtime provenance includes history, retrieved events, and source events for recalled memory')
  assert.match(citedReceipt.receipt, /generic-agent-result/,
    'the final model answer is delivered in the chat receipt, not only saved as a workspace artifact')
  assert.doesNotMatch(citedReceipt.receipt, /参考来源（本轮检索命中）/,
    'verified sources stay outside the delivered Markdown body')
  assert.deepEqual(citedReceipt.citations?.map(({ source, id }) => `${source}:${id}`),
    ['kb:kb-1', 'event:evt_retrieved'], 'verified source markers become structured citations')
  assert(citedReceipt.worklog?.some(step => step.label === '模型缓存与用量' && step.detail?.includes('缓存命中 1024')), 'cache telemetry survives into the durable execution receipt')
  assert.ok((citedReceipt.worklog?.length ?? 0) > 0, 'the runtime receipt retains work milestones')
  assert.doesNotMatch(citedReceipt.receipt, /【工作记录】/,
    'human-only work milestones stay out of the Agent-visible receipt text')
  const citedArtifact = readFileSync(join(citedReceipt.root, citedReceipt.files.at(-1)!), 'utf8')
  assert.doesNotMatch(citedArtifact, /参考来源（本轮检索命中）/,
    'workspace Markdown artifacts contain the answer body, not UI citation scaffolding')
  let delivered: { sessionId: string; target: string; text: string; worklog?: Array<{ label: string; at: string }>; citations?: Array<{ source: string; id: string }> } | null = null
  Object.assign(runtimeCtx, {
    orchestrator: {
      reportAgentResult(sessionId: string, target: string, text: string, _sourceEventIds: string[], worklog?: Array<{ label: string; at: string }>, citations?: Array<{ source: string; id: string }>) {
        delivered = { sessionId, target, text, worklog, citations }
      },
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
  assert.deepEqual(delivered?.citations?.map(({ source, id }) => `${source}:${id}`),
    ['kb:kb-1', 'event:evt_retrieved'], 'dispatcher forwards citations with the Agent result')
  assert.ok(llmMessages.some((message) => message.content.includes('分析本会话的决策背景')))
  delivered = null
  failNextLlmCall = true
  runtimeCtx.emit('orchestrator/delegate', {
    sessionId: 's_open', eventId: 'delegate-failure', target: created.title, instruction: '验证失败阶段可回溯',
  })
  for (let i = 0; i < 100 && !delivered; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  failNextLlmCall = false
  assert.match(delivered?.text ?? '', /【执行失败】/)
  assert.deepEqual(delivered?.worklog?.map((step) => step.label), [
    '开始处理任务', '准备专属工作区', '整理会话、记忆与知识库上下文', '正在请求模型，等待首个响应', '执行失败',
  ], 'the dispatcher passes ordered failure milestones into the result-persistence boundary')
  assert.match(delivered?.worklog?.find((step) => step.label === '执行失败')?.detail ?? '', /LLM 请求失败：fetch failed/u,
    'failure worklogs explain the concrete error rather than only showing a red phase')
  assert.equal(delivered?.worklog?.find((step) => step.label === '执行失败')?.status, 'failed')
  assert.equal(toolInvocations, 0, 'the shared runtime does not invoke tools unless the model requests one')
  toolGraphMode = true
  const toolReceipt = await runtime.perform(created.id, '检索设计资料', { sessionId: 's_open' })
  assert.equal(llmOptions?.profileRef, 'ark-coding', 'shared Agent selects its configured provider profile')
  assert.equal(toolInvocations, 1, 'LangGraph executes only tools enabled in the Agent definition')
  assert.equal(toolReceipt.toolResults?.[0]?.ok, true)
  assert.ok(toolReceipt.worklog?.some((step) => step.kind === 'tool' && step.inputSummary), 'tool worklogs include a sanitized input summary')
  assert.ok(toolReceipt.worklog?.some((step) => step.kind === 'tool' && step.resultSummary), 'tool worklogs include a result summary')
  assert.match(readFileSync(join(toolReceipt.root, toolReceipt.files.at(-1)!), 'utf8'), /Graph answer with a cited result/)
  assert.ok((events.at(-1)?.toolCalls as unknown[] | undefined)?.length, 'tool execution leaves a human-visible activity event')
  failNextLlmCall = true
  await assert.rejects(
    runtime.perform(created.id, '验证模型故障时的阶段保留', { sessionId: 's_open', sourceEventId: 'delegate-failure' }),
    (error: unknown) => error instanceof AgentExecutionFailureError &&
      ['开始处理任务', '准备专属工作区', '整理会话、记忆与知识库上下文', '正在请求模型，等待首个响应', '执行失败']
        .every((label) => error.worklog.some((step) => step.label === label)),
    'an LLM failure keeps the ordered runtime milestones for later human inspection',
  )
  failNextLlmCall = false
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
    assert.equal(requestedModel, 'model.reasoning', 'the low-level adapter still supports explicit internal model selection')
  } finally {
    globalThis.fetch = originalFetch
  }

  await rpc.archiveAgent('team-a', created.id)
  assert.equal(refreshCount, 5, 'creating from a shared template and archiving refresh the live registry')
  assert.throws(() => registry.get(created.id), (error) => error instanceof AgentError && error.code === 'not_found', 'reconciliation removes archived catalog entries')
  const deletable = await rpc.createAgent('team-a', { ...input, title: '临时删除验证助手' })
  joined.add(`s_open:${deletable.id}`)
  memberships.push({ sessionId: 's_open', principalId: deletable.id, role: 'Agent', duty: '' })
  assert.equal(await rpc.deleteAgent('agent-token', deletable.id), null, 'Agent identities cannot delete shared definitions')
  const deletion = await rpc.deleteAgent('team-a', deletable.id)
  assert.equal(deletion.ok, true, 'Team humans can permanently delete shared Agent configuration')
  assert.equal(definitions.has(deletable.id), false, 'deleted Agent configuration is removed from the catalog')
  assert.equal(joined.has(`s_open:${deletable.id}`), false, 'deleting removes the Agent from every session')
  assert.equal(refreshCount, 7, 'creating and deleting the Agent refreshes the live registry')
  console.log(`✓ Teamspace Agent API, explicit invite, full history, and legacy migration passed (${appCount} panels registered)`)
}

await main()
