// space-client-ui-teamspace —— 团队空间整页（IM 化改造 2026-09-30）。
//
// IM 化：发送身份改由服务端登录态（token）注入，前端不再硬编码 DRI；
// 普通文本直达时间线（不再自动入暂存），/stage /commit 为可选批量起草路径。
// Panel 描述符照旧登记进 ctx.ui（P5 组合面按 slot 拼装的可查询台账）。
// 发送走 handleInbound（plugins/staging-commands 导出的语义处理体）—— 与
// POST /api/sessions/:id/messages 同一条代码路径，语义只有一份。
//
// 鉴权口径：RPC 方法首参均为 token（localStorage 'space_token'，由 /login 页
// 写入；HTTP cookie 同源自动携带）。token 无效统一返回 null / unauthorized
// 结构化错误，由前端静默跳登录（登录卡在 space-client-ui-auth 的 /login 页）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type { PublicUser } from 'space-identity'
import type { ReactSummary, SessionEvent } from 'space-event'
import {
  AGENT_HISTORY_BOOTSTRAP_MARKER, AGENT_REVIEW_QUESTION_MARKER,
  DECISION_REVIEW_REQUEST_MARKER, isAgentVisibleEvent,
} from 'space-event'
import { AgentCatalogError } from 'space-agent-catalog'
import type { AgentDefinition, AgentDefinitionInput, AgentDefinitionPatch } from 'space-agent-catalog'
import type { PromptTemplate } from 'space-prompt'
import { randomUUID } from 'node:crypto'
import { handleInbound } from '../../../../plugins/staging-commands/index.ts'

export const name = 'space-client-ui-teamspace'
// 'memory'：AI 记忆透明面板（memories RPC 经 ctx.memory.recall 读取会话沉淀记忆）。
export const inject = ['webui', 'ui', 'session', 'eventLog', 'staging', 'commands', 'orchestrator', 'users', 'agents', 'agentCatalog', 'prompts', 'settings', 'memory', 'sessionWork', 'tools', 'workdir', 'agentInbox', 'agentRuntime']

/** token → 用户；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string): Promise<PublicUser | null> {
  try {
    return await ctx.users.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

/** 回应前置校验：用户必须是该会话的在册成员（listMembers 按 principalId 对拍 userId）。 */
function isMember(ctx: Context, sessionId: string, userId: string): boolean {
  try {
    return ctx.session.listMembers(sessionId, true).some((m) => m.principalId === userId)
  } catch {
    return false
  }
}

/** Teamspace catalog management deliberately accepts any Team human, not only admins. */
async function authTeamHuman(ctx: Context, token: string): Promise<PublicUser | null> {
  const user = await auth(ctx, token)
  return user?.kind === 'human' ? user : null
}

async function sessionMember(ctx: Context, token: string, sessionId: string): Promise<PublicUser | null> {
  const user = await authTeamHuman(ctx, token)
  return user && isMember(ctx, sessionId, user.id) ? user : null
}

function inboxConsumesEvent(event: { kind: string; text: string; voided: boolean; mentions: string[] }, agentId: string): boolean {
  if (event.voided) return false
  if (event.kind === 'message') return !event.text.startsWith(AGENT_REVIEW_QUESTION_MARKER)
  return event.kind === 'decision' && event.text.startsWith(DECISION_REVIEW_REQUEST_MARKER) && event.mentions.includes(agentId)
}

/** Render private inbox audit events with the Agent identity encoded in their payload. */
function presentInboxTraceEvent(ctx: Context, event: SessionEvent): SessionEvent {
  const record = event.toolCalls?.find((call) => call.name === 'agent.inbox.trace')
  if (!record) return event
  try {
    const value = JSON.parse(record.args) as { agentId?: unknown; agentTitle?: unknown; sourceSeq?: unknown }
    if (typeof value.agentId !== 'string' || !value.agentId) return event
    let title = typeof value.agentTitle === 'string' && value.agentTitle ? value.agentTitle : value.agentId
    try { title = ctx.agents.get(value.agentId).descriptor.title || title } catch { /* stable ID remains available */ }
    if (title === value.agentId) try { title = ctx.agentCatalog.get(value.agentId).title || title } catch { /* built-in Agent lookup above */ }
    const seq = typeof value.sourceSeq === 'number' ? value.sourceSeq : null
    return { ...event, text: `Agent 后台处理记录 · ${title} (${value.agentId})${seq === null ? '' : ` · 来源消息 #${seq}`}` }
  } catch { return event }
}

function redactInboxText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[REDACTED]')
}

function safeWorkspaceWorklog(value: unknown): Array<{
  label: string; at: string; kind?: 'phase' | 'tool'; status?: 'running' | 'success' | 'failed';
  detail?: string; toolId?: string; inputSummary?: string; resultSummary?: string; durationMs?: number
}> {
  if (!Array.isArray(value)) return []
  const safeText = (candidate: unknown) => typeof candidate === 'string' ? redactInboxText(candidate).slice(0, 500) : undefined
  return value.filter((step) => Boolean(step) && typeof step === 'object').map((step) => {
    const row = step as Record<string, unknown>
    return {
      label: safeText(row.label) ?? '执行阶段', at: safeText(row.at) ?? '',
      ...(row.kind === 'phase' || row.kind === 'tool' ? { kind: row.kind } : {}),
      ...(row.status === 'running' || row.status === 'success' || row.status === 'failed' ? { status: row.status } : {}),
      ...(['detail', 'toolId', 'inputSummary', 'resultSummary'].reduce((fields, key) => {
        const text = safeText(row[key])
        return text ? { ...fields, [key]: text } : fields
      }, {} as Record<string, string>)),
      ...(typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? { durationMs: row.durationMs } : {}),
    }
  })
}

function safeWorkspaceModelTrace(value: unknown) {
  if (!Array.isArray(value)) return [] as Array<Record<string, unknown>>
  const safe = (item: unknown) => typeof item === 'string' ? redactInboxText(item) : ''
  return value.filter((item) => Boolean(item) && typeof item === 'object').map((item) => {
    const row = item as Record<string, unknown>
    const request = Array.isArray(row.request) ? row.request.filter((message) => Boolean(message) && typeof message === 'object').map((message) => {
      const msg = message as Record<string, unknown>
      const sections = Array.isArray(msg.sections) ? msg.sections.filter((section) => Boolean(section) && typeof section === 'object').map((section) => {
        const part = section as Record<string, unknown>
        return { label: safe(part.label) || '未标注区块', source: safe(part.source) || '来源未记录', content: safe(part.content) }
      }) : undefined
      return {
        role: msg.role === 'system' || msg.role === 'assistant' ? msg.role : 'user',
        source: safe(msg.source) || '来源未标注', content: safe(msg.content),
        ...(sections?.length ? { sections } : {}),
      }
    }) : []
    const toolCalls = Array.isArray(row.toolCalls) ? row.toolCalls.filter((call) => Boolean(call) && typeof call === 'object').map((call) => {
      const tool = call as Record<string, unknown>
      return {
        toolId: safe(tool.toolId) || 'unknown', args: safe(tool.args),
        ...(tool.status === 'success' || tool.status === 'failed' ? { status: tool.status } : {}),
        ...(typeof tool.result === 'string' ? { result: safe(tool.result) } : {}),
        ...(typeof tool.error === 'string' ? { error: safe(tool.error) } : {}),
        ...(typeof tool.durationMs === 'number' ? { durationMs: tool.durationMs } : {}),
      }
    }) : []
    return {
      index: Number(row.index) || 0, model: safe(row.model) || null, profileRef: safe(row.profileRef) || null,
      startedAt: safe(row.startedAt), completedAt: safe(row.completedAt),
      status: row.status === 'completed' ? 'completed' : 'failed', request,
      response: typeof row.response === 'string' ? safe(row.response) : undefined,
      responseTruncated: row.responseTruncated === true,
      toolCalls, error: typeof row.error === 'string' ? safe(row.error) : undefined,
    }
  })
}

function workspaceInboxTrace(events: SessionEvent[], sourceEventId: string, agentId: string) {
  for (const event of [...events].reverse()) {
    if (event.voided || event.sourceEventId !== sourceEventId || event.authorKind !== 'system') continue
    for (const call of event.toolCalls) {
      if (call.name !== 'agent.inbox.trace') continue
      try {
        const value = JSON.parse(call.args) as Record<string, unknown>
        if (value.agentId !== agentId || !Array.isArray(value.steps)) continue
        const safe = (item: unknown) => typeof item === 'string' ? redactInboxText(item).slice(0, 1200) : ''
        return {
          agentId, agentTitle: safe(value.agentTitle) || agentId,
          status: value.status === 'failed' ? 'failed' as const : 'success' as const,
          startedAt: safe(value.startedAt), completedAt: safe(value.completedAt),
          modelTrace: safeWorkspaceModelTrace(value.modelTrace),
          steps: value.steps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object').map((step) => ({
            label: safe(step.label) || '处理阶段', detail: safe(step.detail), at: safe(step.at),
            status: step.status === 'failed' ? 'failed' as const : 'success' as const,
          })),
        }
      } catch { /* Ignore malformed legacy or interrupted trace events. */ }
    }
  }
  return null
}

export interface TeamspaceApiConfig {
  publicBaseUrl: string | null
  port: number
}

/** A reverse proxy may publish the API on the same HTTPS origin as Teamspace. */
export function resolveTeamspaceApiConfig(env: NodeJS.ProcessEnv = process.env): TeamspaceApiConfig {
  const rawPort = env.APP_PORT ?? '8080'
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('[teamspace] APP_PORT 必须是 1–65535 的端口号')
  }
  const rawBaseUrl = env.TEAMSPACE_API_BASE_URL?.trim()
  if (!rawBaseUrl) return { publicBaseUrl: null, port }
  let parsed: URL
  try { parsed = new URL(rawBaseUrl) }
  catch { throw new Error('[teamspace] TEAMSPACE_API_BASE_URL 必须是完整的 HTTP(S) origin') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('[teamspace] TEAMSPACE_API_BASE_URL 只接受不含路径、凭据、查询或片段的 HTTP(S) origin')
  }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('[teamspace] 生产环境的 TEAMSPACE_API_BASE_URL 必须使用 HTTPS')
  }
  return { publicBaseUrl: parsed.origin, port }
}

/** One-time import from the old settings-backed definitions; no owner is carried forward. */
export async function migrateLegacyAgentDefinitions(ctx: Context): Promise<number> {
  const legacy = ctx.settings.get<Array<{ id: string; title: string; roleLabel?: string; promptRef?: string }>>('agent.custom', [])
  let imported = 0
  for (const old of legacy) {
    try { ctx.agentCatalog.get(old.id); continue } catch { /* import below */ }
    try {
      ctx.agentCatalog.create({
        title: old.title,
        description: old.roleLabel || `协助团队完成「${old.title}」相关工作。`,
        promptRef: old.promptRef || '', toolIds: [],
        contextSources: ['session', 'agent-memory', 'team-kb'],
        memoryPolicy: 'agent', speechPolicy: 'passive',
      }, old.id)
      imported++
    } catch (e) {
      console.error(`[teamspace-agents] 旧 Agent ${old.id} 导入失败，保留兼容设置：${(e as Error).message}`)
      return imported
    }
  }
  if (legacy.length) {
    ctx.settings.set('agent.custom', undefined)
    // Older adapter used to auto-join every open conversation. Restore explicit
    // invitation semantics while retaining the identity and historical rows.
    for (const old of legacy) {
      for (const session of ctx.session.listSessions()) {
        try { ctx.session.leave(session.id, old.id) } catch { /* was not an active member */ }
      }
    }
    ctx.agents.refreshCatalog()
  }
  return imported
}

/** Join one Agent explicitly. Existing session history is not sliced or copied: the
 * member ID can read the complete event stream through agentHistoryForSession. */
export function inviteAgentToSession(ctx: Context, sessionId: string, agentId: string, inviterId: string): { joined: boolean; title: string } {
  const session = ctx.session.getSession(sessionId)
  if (!session) throw new Error(`会话 ${sessionId} 不存在`)
  if (session.status !== 'open') throw new Error(`会话 ${sessionId} 已关闭`)
  let title: string
  try { title = ctx.agentCatalog.get(agentId).title }
  catch { title = ctx.agents.get(agentId).descriptor.title }
  const prior = ctx.session.listMembers(sessionId, true).find((m) => m.principalId === agentId)
  if (prior) return { joined: false, title }
  ctx.session.join({ sessionId, principalId: agentId, role: '成员', duty: title })
  ctx.eventLog.append({
    id: randomUUID(), sessionId, authorId: null, phaseId: null,
    authorKind: 'system', kind: 'system',
    text: `${AGENT_HISTORY_BOOTSTRAP_MARKER} 已邀请 Agent「${title}」加入会话（邀请者 ${inviterId}；可访问完整历史，历史消息将按顺序进入处理队列）`,
    mentions: [agentId], toolCalls: [], replyMode: '',
  })
  return { joined: true, title }
}

/** Full ordered, Agent-visible conversation history; human-only tool traces are omitted. */
export function agentHistoryForSession(ctx: Context, sessionId: string, agentId: string): SessionEvent[] {
  const member = ctx.session.listMembers(sessionId, true).find((m) => m.principalId === agentId)
  if (!member) throw new Error(`Agent ${agentId} 尚未加入会话 ${sessionId}`)
  return ctx.eventLog.listBySession(sessionId).filter(isAgentVisibleEvent)
}

/** AgentSnapshot 的客户端视图（前端只显示 id/标题/状态/职责）。 */
interface AgentView { id: string; title: string; status: string; iconId?: string; capabilities?: string[] }

export function apply(ctx: Context) {
  const publicApiConfig = resolveTeamspaceApiConfig()
  void migrateLegacyAgentDefinitions(ctx).then((n) => {
    if (n) console.log(`[teamspace-agents] 已迁移 ${n} 个共享 Agent 定义`)
  }).catch((e) => console.error(`[teamspace-agents] legacy Agent migration failed: ${(e as Error).message}`))
  ctx.ui.registerPanel({ key: 'space.timeline', slot: 'bottom', title: '时间线', order: 0 })
  ctx.ui.registerPanel({ key: 'space.turn-status', slot: 'right', title: '轮次状态', order: 0 })
  ctx.ui.registerPanel({ key: 'space.members', slot: 'right', title: '成员 / @ 清单', order: 1 })
  ctx.ui.registerPanel({ key: 'space.composer', slot: 'composer', title: '输入区', order: 0 })

  ctx.webui.addEntry<Record<string, (...args: any[]) => unknown>>(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/teamspace', '/teamspace/agents', '/teamspace/memories', '/teamspace/workspaces'],
    },
    {
      async me(token: string) {
        return auth(ctx, token)
      },
      // IM 化（2026-09-30）：AI 成员工作状态（协作面板「成员状态」区数据源）。
      async agents(token: string): Promise<AgentView[] | null> {
        if (!(await auth(ctx, token))) return null
        return ctx.agents.list().map((a) => ({
          id: a.descriptor.id,
          title: a.descriptor.title,
          status: a.status,
          iconId: (() => { try { return ctx.agentCatalog.get(a.descriptor.id).iconId } catch { return 'UserFilled' } })(),
          capabilities: [...a.descriptor.capabilities],
        }))
      },
      /** Shared Agent definitions: any Team human may view and configure them. */
      async agentDefinitions(token: string): Promise<AgentDefinition[] | null> {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.agentCatalog.list()
      },
      /** Paginated explorer data for one Agent's durable memory scope. */
      async agentMemories(token: string, agentId: string, offset = 0, includeInvalidated = false, limit = 20, folderPath = '') {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        try {
          const result = await ctx.memory.list(`agent:${String(agentId)}`, {
            offset: Math.max(0, Number(offset) || 0), limit: Math.min(50, Math.max(1, Number(limit) || 20)),
            includeInvalidated: Boolean(includeInvalidated), folderPath: String(folderPath || '') || undefined, excludeSystem: true,
          })
          return {
            total: result.total,
            items: result.items.map((item) => ({
              ...item,
              text: item.text
                .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
                .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
                .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[REDACTED]'),
            })),
          }
        } catch { return { total: 0, items: [] } }
      },
      async agentMemoryCatalog(token: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.agentCatalog.list(true).map(({ id, title, status, iconId }) => ({ id, title, status, iconId }))
      },
      async agentMemoryFolders(token: string, agentId: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        return (await ctx.memory.listFolders(`agent:${String(agentId)}`)).filter((folder) => !folder.path.startsWith('.system'))
      },
      async agentMemoryCreateFolder(token: string, agentId: string, name: string, parentPath = '') {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        try { return await ctx.memory.createFolder(`agent:${String(agentId)}`, String(name ?? ''), String(parentPath ?? '')) }
        catch (error) { return { error: (error as Error).message } }
      },
      async agentMemoryMove(token: string, agentId: string, memoryId: string, folderPath: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        try {
          const item = await ctx.memory.move(`agent:${String(agentId)}`, String(memoryId), String(folderPath ?? ''))
          return { id: item.id, folderPath: item.folderPath }
        } catch (error) { return { error: (error as Error).message } }
      },
      /** Current progress, pending per-Agent session inboxes, and safe workspace metadata. */
      async agentWorkspaceOverview(token: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        const definitions = ctx.agentCatalog.list(true)
        const agents = await Promise.all(definitions.map(async (definition) => {
          let runtime: ReturnType<typeof ctx.agents.get> | null = null
          try { runtime = ctx.agents.get(definition.id) } catch { /* archived Agent */ }
          const listing = await ctx.workdir.browse(definition.id).catch(() => ({ exists: false }))
          return { id: definition.id, title: definition.title, status: runtime?.status ?? definition.status,
            iconId: definition.iconId, workdirAvailable: listing.exists }
        }))
        const progress = ctx.agentRuntime.listActiveProgress().map(({
          delta: _delta, streamText: _streamText, streamCharacterCount: _streamCount,
          streamTruncated: _streamTruncated, ...run
        }) => run)
        const work = ctx.sessionWork.state()
        const agentIds = new Set(agents.map((agent) => agent.id))
        const sessions = ctx.session.listSessions().map((session) => ({
          session,
          members: ctx.session.listMembers(session.id, true).filter((member) => agentIds.has(member.principalId)),
          events: ctx.eventLog.listBySession(session.id),
        }))
        const inboxes = await Promise.all(agents.map(async (agent) => {
          const pending: Array<{ sessionId: string; sessionTitle: string; count: number; processedCount: number; cursor: number; latestSeq: number; active: boolean }> = []
          const recent = []
          for (const { session, members, events } of sessions) {
            if (!members.some((member) => member.principalId === agent.id)) continue
            const cursor = await ctx.agentInbox.cursor(agent.id, session.id).catch(() => 0)
            const count = events.filter((event) => event.seq > cursor && inboxConsumesEvent(event, agent.id)).length
            const processed = events.filter((event) => event.seq <= cursor && inboxConsumesEvent(event, agent.id)).sort((a, b) => b.seq - a.seq)
            const processedCount = processed.length
            const processedIds = new Set(processed.map((event) => event.id))
            const conversationRows = processed.filter((event) => !(event.authorKind === 'agent' && event.authorId === agent.id
              && event.kind === 'message' && event.sourceEventId && processedIds.has(event.sourceEventId)))
            const recordsBySource = new Map<string, SessionEvent[]>()
            for (const record of events) {
              if (!record.sourceEventId || record.voided) continue
              const group = recordsBySource.get(record.sourceEventId) ?? []
              group.push(record)
              recordsBySource.set(record.sourceEventId, group)
            }
            for (const [index, event] of conversationRows.entries()) {
              const records = recordsBySource.get(event.id) ?? []
              const trace = workspaceInboxTrace(records, event.id, agent.id)
              const reply = [...records].reverse().find((item) => !item.voided && item.kind === 'message'
                && item.authorKind === 'agent' && item.authorId === agent.id && item.sourceEventId === event.id)
              const outcome = [...records].reverse().find((item) => !item.voided && item.sourceEventId === event.id
                && item.toolCalls.some((call) => {
                  if (call.name !== 'agent.reply.outcome') return false
                  try { const value = JSON.parse(call.args); return value.agentId === agent.id && value.status === 'blocked' } catch { return false }
                }))
              const failed = reply?.text.startsWith('【执行失败】') || trace?.status === 'failed'
              recent.push({ eventId: event.id, seq: event.seq, sessionId: session.id, sessionTitle: session.title,
                text: redactInboxText(event.text).slice(0, 160), at: reply?.ts ?? outcome?.ts ?? trace?.completedAt ?? event.ts,
                status: failed ? 'failed' : reply ? 'replied' : outcome ? 'blocked' : trace ? 'scanned' : 'legacy',
                result: redactInboxText(reply?.text ?? outcome?.text ?? trace?.steps.at(-1)?.detail ?? '旧记录只保存了游标，缺少处理详情').slice(0, 160),
                historyPage: Math.floor(index / 20) + 1 })
            }
            if (count || processedCount) pending.push({ sessionId: session.id, sessionTitle: session.title, count, processedCount, cursor,
              latestSeq: events.reduce((max, event) => Math.max(max, event.seq), 0), active: ctx.agentInbox.activeSessionId() === session.id })
          }
          return { agentId: agent.id, pending, recent: recent.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8) }
        }))
        return { agents, progress, inboxes, processing: ctx.agentInbox.processing(), activeSessionId: work.activeSessionId,
          queue: work.queue.map((item) => ({ ...item })) }
      },
      /** Paginated, redacted events that this Agent's background inbox has not consumed yet. */
      async agentWorkspaceInbox(token: string, agentId: string, sessionId: string, page = 1, pageSize = 20) {
        if (!(await authTeamHuman(ctx, token))) return null
        const id = String(agentId ?? ''), sid = String(sessionId ?? '')
        try { ctx.agentCatalog.get(id) } catch { return null }
        const session = ctx.session.listSessions().find((item) => item.id === sid)
        if (!session || !ctx.session.listMembers(sid, true).some((member) => member.principalId === id)) return null
        const cursor = await ctx.agentInbox.cursor(id, sid).catch(() => 0)
        const allEvents = ctx.eventLog.listBySession(sid)
        const events = allEvents
          .filter((event) => event.seq > cursor && inboxConsumesEvent(event, id))
          .sort((a, b) => a.seq - b.seq)
        const size = Math.min(50, Math.max(1, Number(pageSize) || 20))
        const currentPage = Math.max(1, Number(page) || 1)
        const items = await Promise.all(events.slice((currentPage - 1) * size, currentPage * size).map(async (event) => {
          const author = event.authorId ? await ctx.users.byId(event.authorId).catch(() => null) : null
          const replies = allEvents.filter((candidate) => !candidate.voided && candidate.authorKind === 'agent' &&
            candidate.authorId === id && candidate.kind === 'message' && candidate.sourceEventId === event.id)
          // Agent replies are themselves inbox events for that Agent. When the
          // reply is the selected history row, expose its execution record on
          // the row instead of incorrectly saying it has no separate reply.
          const executionEvents = event.authorKind === 'agent' && event.authorId === id && event.kind === 'message' && event.sourceEventId
            ? [event, ...replies.filter((reply) => reply.id !== event.id)]
            : replies
          const executions = await Promise.all(executionEvents.map(async (reply) => {
            const replyAuthor = reply.authorId ? await ctx.users.byId(reply.authorId).catch(() => null) : null
            const record = reply.toolCalls.find((call) => call.name === 'agent.worklog')
            let worklog: ReturnType<typeof safeWorkspaceWorklog> = []
            if (record) try { worklog = safeWorkspaceWorklog(JSON.parse(record.args)) } catch { /* malformed legacy worklog is omitted */ }
            const modelTraceRecord = reply.toolCalls.find((call) => call.name === 'agent.model.trace')
            let modelTrace: ReturnType<typeof safeWorkspaceModelTrace> = []
            if (modelTraceRecord) try { modelTrace = safeWorkspaceModelTrace(JSON.parse(modelTraceRecord.args)) } catch { /* malformed trace is omitted */ }
            return {
              id: reply.id, at: reply.ts, author: replyAuthor?.displayName ?? reply.authorId ?? 'Agent',
              text: redactInboxText(reply.text), failed: reply.text.startsWith('【执行失败】'), worklog, modelTrace,
              sourceEventIds: reply.sourceEventIds ?? [],
              sourceEvents: await Promise.all((reply.sourceEventIds ?? []).map(async (sourceId) => {
                const source = allEvents.find((candidate) => candidate.id === sourceId)
                if (!source) return { id: sourceId, seq: null, at: '', author: '已撤回或不可用', text: '' }
                const sourceAuthor = source.authorId ? await ctx.users.byId(source.authorId).catch(() => null) : null
                return { id: source.id, seq: source.seq, at: source.ts,
                  author: sourceAuthor?.displayName ?? source.authorId ?? '系统', text: redactInboxText(source.text).slice(0, 1000) }
              })),
              citations: (reply.citations ?? []).map((citation) => ({ ...citation, title: redactInboxText(citation.title) })),
            }
          }))
          const liveExecutions = ctx.agentRuntime.listActiveProgress().filter((run) => run.sourceEventId === event.id).map((run) => ({
            runId: run.runId, title: redactInboxText(run.title), phase: run.phase, at: run.at,
            ...(run.step ? { step: safeWorkspaceWorklog([run.step])[0] } : {}),
            steps: safeWorkspaceWorklog(run.steps), currentText: redactInboxText(run.streamText),
          }))
          return {
            id: event.id, seq: event.seq, at: event.ts, kind: event.kind,
            author: author?.displayName ?? (event.authorId || '系统'),
            authorKind: event.authorKind, text: redactInboxText(event.text), mentions: event.mentions,
            inboxTrace: workspaceInboxTrace(allEvents, event.id, id), executions, liveExecutions,
          }
        }))
        return {
          sessionId: sid, sessionTitle: session.title, total: events.length, page: currentPage, pageSize: size,
          cursor, latestSeq: allEvents.reduce((max, event) => Math.max(max, event.seq), 0),
          active: ctx.agentInbox.activeSessionId() === sid, items,
        }
      },
      /** Paginated history already consumed by this Agent's durable inbox cursor. */
      async agentWorkspaceHistory(token: string, agentId: string, sessionId: string, page = 1, pageSize = 20) {
        if (!(await authTeamHuman(ctx, token))) return null
        const id = String(agentId ?? ''), sid = String(sessionId ?? '')
        try { ctx.agentCatalog.get(id) } catch { return null }
        const session = ctx.session.listSessions().find((item) => item.id === sid)
        if (!session || !ctx.session.listMembers(sid, true).some((member) => member.principalId === id)) return null
        const cursor = await ctx.agentInbox.cursor(id, sid).catch(() => 0)
        const allEvents = ctx.eventLog.listBySession(sid)
        const scannedEvents = allEvents
          .filter((event) => event.seq <= cursor && inboxConsumesEvent(event, id))
          .sort((a, b) => b.seq - a.seq)
        const scannedIds = new Set(scannedEvents.map((event) => event.id))
        // A reply linked to a consumed source is rendered inside that source row.
        // Keeping a second top-level row for the same Agent utterance duplicates it.
        const events = scannedEvents.filter((event) => !(event.authorKind === 'agent' && event.authorId === id
          && event.kind === 'message' && event.sourceEventId && scannedIds.has(event.sourceEventId)))
        const size = Math.min(50, Math.max(1, Number(pageSize) || 20))
        const currentPage = Math.max(1, Number(page) || 1)
        const items = await Promise.all(events.slice((currentPage - 1) * size, currentPage * size).map(async (event) => {
          const author = event.authorId ? await ctx.users.byId(event.authorId).catch(() => null) : null
          const replies = allEvents.filter((candidate) => !candidate.voided && candidate.authorKind === 'agent' &&
            candidate.authorId === id && candidate.kind === 'message' && candidate.sourceEventId === event.id)
          const executionEvents = event.authorKind === 'agent' && event.authorId === id && event.kind === 'message' && event.sourceEventId
            ? [event, ...replies.filter((reply) => reply.id !== event.id)]
            : replies
          const executions = await Promise.all(executionEvents.map(async (reply) => {
            const replyAuthor = reply.authorId ? await ctx.users.byId(reply.authorId).catch(() => null) : null
            const record = reply.toolCalls.find((call) => call.name === 'agent.worklog')
            let worklog: ReturnType<typeof safeWorkspaceWorklog> = []
            if (record) try { worklog = safeWorkspaceWorklog(JSON.parse(record.args)) } catch { /* malformed legacy worklog is omitted */ }
            const modelTraceRecord = reply.toolCalls.find((call) => call.name === 'agent.model.trace')
            let modelTrace: ReturnType<typeof safeWorkspaceModelTrace> = []
            if (modelTraceRecord) try { modelTrace = safeWorkspaceModelTrace(JSON.parse(modelTraceRecord.args)) } catch { /* malformed trace is omitted */ }
            return {
              id: reply.id, at: reply.ts, author: replyAuthor?.displayName ?? reply.authorId ?? 'Agent',
              text: redactInboxText(reply.text), failed: reply.text.startsWith('【执行失败】'), worklog, modelTrace,
              sourceEventIds: reply.sourceEventIds ?? [],
              sourceEvents: await Promise.all((reply.sourceEventIds ?? []).map(async (sourceId) => {
                const source = allEvents.find((candidate) => candidate.id === sourceId)
                if (!source) return { id: sourceId, seq: null, at: '', author: '已撤回或不可用', text: '' }
                const sourceAuthor = source.authorId ? await ctx.users.byId(source.authorId).catch(() => null) : null
                return { id: source.id, seq: source.seq, at: source.ts,
                  author: sourceAuthor?.displayName ?? source.authorId ?? '系统', text: redactInboxText(source.text).slice(0, 1000) }
              })),
              citations: (reply.citations ?? []).map((citation) => ({ ...citation, title: redactInboxText(citation.title) })),
            }
          }))
          const liveExecutions = ctx.agentRuntime.listActiveProgress().filter((run) => run.sourceEventId === event.id).map((run) => ({
            runId: run.runId, title: redactInboxText(run.title), phase: run.phase, at: run.at,
            ...(run.step ? { step: safeWorkspaceWorklog([run.step])[0] } : {}),
            steps: safeWorkspaceWorklog(run.steps), currentText: redactInboxText(run.streamText),
          }))
          return {
            id: event.id, seq: event.seq, at: event.ts, kind: event.kind,
            author: author?.displayName ?? (event.authorId || '系统'),
            authorKind: event.authorKind, text: redactInboxText(event.text), mentions: event.mentions,
            inboxTrace: workspaceInboxTrace(allEvents, event.id, id), executions, liveExecutions,
          }
        }))
        return {
          sessionId: sid, sessionTitle: session.title, total: events.length, scannedTotal: scannedEvents.length, page: currentPage, pageSize: size,
          cursor, latestSeq: allEvents.reduce((max, event) => Math.max(max, event.seq), 0),
          active: ctx.agentInbox.activeSessionId() === sid, items,
        }
      },
      async agentWorkspaceBrowse(token: string, agentId: string, path = '') {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        try { return await ctx.workdir.browse(String(agentId), String(path ?? '')) }
        catch (error) { return { error: (error as Error).message } }
      },
      async agentWorkspaceRead(token: string, agentId: string, path: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { ctx.agentCatalog.get(String(agentId)) } catch { return null }
        try { return { text: await ctx.workdir.readText(String(agentId), String(path ?? '')) } }
        catch (error) { return { error: (error as Error).message } }
      },
      async sharedWorkspaceBrowse(token: string, path = '') {
        if (!(await authTeamHuman(ctx, token))) return null
        try { return await ctx.workdir.browseShared(String(path ?? '')) }
        catch (error) { return { exists: false, path: String(path ?? ''), entries: [], error: (error as Error).message } }
      },
      async sharedWorkspaceRead(token: string, path: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { return { text: await ctx.workdir.readSharedText(String(path ?? '')) } }
        catch (error) { return { error: (error as Error).message } }
      },
      async transferWorkspaceFile(token: string, sourceAgentId: string, path: string, targetAgentId = '') {
        if (!(await authTeamHuman(ctx, token))) return null
        try {
          const source = sourceAgentId ? { kind: 'agent' as const, agentId: String(sourceAgentId) } : { kind: 'shared' as const }
          const target = targetAgentId
            ? { kind: 'agent' as const, agentId: String(targetAgentId) }
            : { kind: 'shared' as const }
          await ctx.workdir.copyFile(source, String(path ?? ''), target)
          return { ok: true as const }
        } catch (error) {
          return { error: (error as Error).message }
        }
      },
      async agentTemplates(token: string, includeArchived = false) {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.agentCatalog.listTemplates(includeArchived)
      },
      async saveAgentTemplate(token: string, input: { title: string; summary: string; input: AgentDefinitionInput }, id?: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { return ctx.agentCatalog.saveTemplate(input, id) }
        catch (e) {
          return { error: e instanceof AgentCatalogError ? e.code : 'save_template_failed', detail: (e as Error).message }
        }
      },
      async archiveAgentTemplate(token: string, id: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { return ctx.agentCatalog.archiveTemplate(String(id)) }
        catch (e) {
          return { error: e instanceof AgentCatalogError ? e.code : 'archive_template_failed', detail: (e as Error).message }
        }
      },
      async restoreAgentTemplate(token: string, id: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try { return ctx.agentCatalog.restoreTemplate(String(id)) }
        catch (e) {
          return { error: e instanceof AgentCatalogError ? e.code : 'restore_template_failed', detail: (e as Error).message }
        }
      },
      /** Only public model-profile metadata is visible to Team members; credentials stay Admin-only. */
      async llmProfiles(token: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        return (ctx.settings.get<Array<{ id: string; name: string }>>('llm.profiles', []) ?? []).map((profile) => ({
          id: profile.id, name: profile.name,
          model: ctx.settings.get<string>(`llm.profile.${profile.id}.model`, ''),
        }))
      },
      /** Available registered tools; handlers and other runtime internals stay server-side. */
      async toolCatalog(token: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.tools.list().map(({ id, title, capabilities }) => ({ id, title, capabilities: [...capabilities] }))
      },
      /** Team-shared prompt templates; every authenticated Team human can configure them. */
      async promptTemplates(token: string): Promise<PromptTemplate[] | null> {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.prompts.list()
      },
      async savePromptTemplate(token: string, ref: string, title: string, body: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try {
          const template = ctx.prompts.upsert(String(ref ?? ''), String(title ?? ''), String(body ?? ''))
          return { ok: true as const, template }
        } catch (e) {
          return { error: 'invalid_prompt', detail: (e as Error).message }
        }
      },
      async createAgent(token: string, input: AgentDefinitionInput): Promise<AgentDefinition | { error: string; detail: string } | null> {
        const user = await authTeamHuman(ctx, token)
        if (!user) return null
        try {
          if (input.templateOrigin && !ctx.agentCatalog.hasTemplateVersion(input.templateOrigin.id, input.templateOrigin.version)) {
            throw new AgentCatalogError('invalid_input', '所选 Agent 起始模板版本不存在')
          }
          const def = ctx.agentCatalog.create(input, `a_${randomUUID()}`)
          try { ctx.users.registerAgent(def.id, def.title) } catch (e) {
            ctx.agentCatalog.archive(def.id)
            ctx.agents.refreshCatalog()
            throw e
          }
          ctx.agents.refreshCatalog()
          return def
        } catch (e) {
          return { error: e instanceof AgentCatalogError ? e.code : 'create_failed', detail: (e as Error).message }
        }
      },
      async updateAgent(token: string, id: string, patch: AgentDefinitionPatch) {
        if (!(await authTeamHuman(ctx, token))) return null
        try {
          const def = ctx.agentCatalog.update(String(id), patch)
          ctx.agents.refreshCatalog()
          return def
        }
        catch (e) { return { error: e instanceof AgentCatalogError ? e.code : 'update_failed', detail: (e as Error).message } }
      },
      async archiveAgent(token: string, id: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try {
          const archived = ctx.agentCatalog.archive(String(id))
          ctx.agents.refreshCatalog()
          for (const session of ctx.session.listSessions()) {
            try { ctx.session.leave(session.id, archived.id) } catch { /* not an active member */ }
          }
          return { ok: true, definition: archived }
        } catch (e) { return { error: e instanceof AgentCatalogError ? e.code : 'archive_failed', detail: (e as Error).message } }
      },
      async deleteAgent(token: string, id: string) {
        if (!(await authTeamHuman(ctx, token))) return null
        try {
          const agentId = String(id ?? '')
          try {
            if (ctx.agents.get(agentId).status === 'working') {
              return { error: 'agent_busy', detail: 'Agent 正在处理任务，请等任务结束后再删除。' }
            }
          } catch { /* archived definitions are no longer in the live registry */ }
          const deleted = ctx.agentCatalog.delete(agentId)
          ctx.agents.refreshCatalog()
          for (const session of ctx.session.listSessions()) {
            try { ctx.session.leave(session.id, deleted.id) } catch { /* not an active member */ }
          }
          return { ok: true, definition: deleted }
        } catch (e) { return { error: e instanceof AgentCatalogError ? e.code : 'delete_failed', detail: (e as Error).message } }
      },
      /** Explicit invitation grants this Agent the full existing event history. */
      async inviteAgent(token: string, sessionId: string, agentId: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return null
        try {
          const result = inviteAgentToSession(ctx, String(sessionId), String(agentId), user.id)
          return { ok: true, joined: result.joined, title: result.title, detail: `已邀请「${result.title}」；历史消息将按顺序进入处理队列` }
        } catch (e) { return { error: 'invite_failed', detail: (e as Error).message } }
      },
      async agentHistory(token: string, sessionId: string, agentId: string): Promise<SessionEvent[] | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        try { return agentHistoryForSession(ctx, String(sessionId), String(agentId)) }
        catch { return null }
      },
      async sessions(token: string) {
        const user = await authTeamHuman(ctx, token)
        if (!user) return []
        return ctx.session.listSessions().filter((session) => isMember(ctx, session.id, user.id))
      },
      async decide(token: string, sessionId: string, action: string, eventId: string, reason = '') {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请登录并加入此会话后再操作' }
        const activeMembers = ctx.session.listMembers(sessionId, true)
        const caller = activeMembers.find((member) => member.principalId === user.id)
        const hasAssignedDri = activeMembers.some((member) => member.role === 'DRI')
        if (caller?.role !== 'DRI' && !(caller?.role === '群主' && !hasAssignedDri)) {
          return { error: 'forbidden', detail: '只有本会话 DRI 可以处理 Agent 回复；未指派 DRI 时群主可以代为处理' }
        }
        const allowed = new Set(['pass', 'reject', 'modify', 'defer', 'recall', 'redo'])
        if (!allowed.has(action)) return { error: 'invalid_action', detail: '不支持此决策操作' }
        try {
          const rest = [action, String(eventId), String(reason ?? '').trim()].filter(Boolean).join(' ')
          const reply = await ctx.commands.dispatch(
            { sessionId, authorId: user.id, arg: '', args: [], raw: '' },
            { name: 'decision', rest },
          )
          return { ok: true, text: reply.text }
        } catch (e) { return { error: 'decision_failed', detail: (e as Error).message } }
      },
      async generateSummary(token: string, sessionId: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请登录并加入此会话后再操作' }
        if (ctx.session.getSession(sessionId)?.status !== 'open') {
          return { error: 'session_closed', detail: '已结束的会话不能生成新纪要' }
        }
        try {
          const reply = await ctx.commands.dispatch(
            { sessionId, authorId: user.id, arg: '', args: [], raw: '' },
            { name: 'summary', rest: '' },
          )
          return { ok: true, text: reply.text }
        } catch (e) { return { error: 'summary_failed', detail: (e as Error).message } }
      },
      // 消息搜索（FTS/LIKE 已封装在 eventLog store；query 为空直接返回 []）。
      async search(token: string, sessionId: string, query: string): Promise<unknown[] | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        if (!String(query ?? '').trim()) return []
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.eventLog.search(sessionId, query)
      },
      async events(token: string, sessionId: string) {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.eventLog.listBySession(sessionId).map((event) => presentInboxTraceEvent(ctx, event))
      },
      async event(token: string, sessionId: string, eventId: string): Promise<SessionEvent | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        const event = ctx.eventLog.listBySession(sessionId).find((item) => item.id === eventId)
        return event ? presentInboxTraceEvent(ctx, event) : null
      },
      async members(token: string, sessionId: string) {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      async staging(token: string, sessionId: string) {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.staging.list(sessionId)
      },
      async turn(token: string, sessionId: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return null
        const state = ctx.sessionWork.state()
        const visibleIds = new Set(ctx.session.listSessions()
          .filter((session) => isMember(ctx, session.id, user.id))
          .map((session) => session.id))
        const sessionWork = {
          activeSessionId: state.activeSessionId && visibleIds.has(state.activeSessionId) ? state.activeSessionId : null,
          owners: state.activeSessionId && visibleIds.has(state.activeSessionId) ? state.owners : [],
          queue: state.queue.filter((item) => visibleIds.has(item.sessionId)),
        }
        return { ...ctx.orchestrator.turn(sessionId), sessionWork }
      },
      // Public HTTPS origins support a standard reverse proxy; otherwise retain
      // the direct browser-facing APP_PORT mapping.
      async apiConfig(token: string): Promise<TeamspaceApiConfig | null> {
        return (await auth(ctx, token)) ? publicApiConfig : null
      },
      // AI 记忆透明面板（2026-10-01）：读取本会话沉淀的记忆（最多 10 条）。
      // memory 服务未就绪 / recall 抛错时返回 []（面板显示「暂无沉淀记忆」）。
      // 人类用户名映射（消息作者显示名用 —— 成员表缺行时兜底）。
      async humans(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.users.listHumans()
      },
      async memories(token: string, sessionId: string): Promise<Array<{ text: string }> | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        try {
          const list = await (ctx as any).memory.recall(`session:${sessionId}`, { limit: 10, kind: 'summary' })
          return (Array.isArray(list) ? list : []).map((m: unknown) => ({
            text: String((m as { text?: unknown })?.text ?? m ?? ''),
          })).filter((m: { text: string }) => m.text)
        } catch {
          return []
        }
      },
      // 团队待办存记忆层 kind='todo'；操作由协作面板的表单和行内按钮完成。
      async todos(token: string, sessionId: string):
        Promise<Array<{ id: string; done: boolean; text: string; createdAt: string }> | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        try {
          const list = await ctx.memory.recall(`session:${sessionId}`, { kind: 'todo', limit: 50 })
          const out: Array<{ id: string; done: boolean; text: string; createdAt: string }> = []
          for (const m of (Array.isArray(list) ? list : [])) {
            try {
              const p = JSON.parse(String(m.text)) as { done?: unknown; text?: unknown }
              if (typeof p.done === 'boolean' && typeof p.text === 'string') {
                out.push({ id: m.id, done: p.done, text: p.text, createdAt: m.createdAt })
              }
              // 字段形状不对 = 脏数据，跳过该条（不炸整个面板）。
            } catch { /* JSON 解析失败 = 脏数据，跳过该条 */ }
          }
          return out
        } catch {
          return [] // memory 未就绪 / recall 抛错：面板显示「暂无待办」
        }
      },
      async addTodo(token: string, sessionId: string, rawText: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请登录并加入此会话后再操作' }
        const text = String(rawText ?? '').trim()
        if (!text || text.length > 500) return { error: 'invalid_text', detail: '待办需为 1–500 个字符' }
        try {
          await ctx.memory.remember(`session:${sessionId}`, 'todo', JSON.stringify({ done: false, text }), {
            weight: 0.8, authorId: user.id,
          })
          return { ok: true }
        } catch (e) { return { error: 'save_failed', detail: (e as Error).message } }
      },
      async setTodoDone(token: string, sessionId: string, id: string, done: boolean) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请登录并加入此会话后再操作' }
        try {
          const list = await ctx.memory.recall(`session:${sessionId}`, { kind: 'todo', limit: 100 })
          const target = (Array.isArray(list) ? list : []).find((item) => item.id === String(id))
          if (!target) return { error: 'not_found', detail: '待办已不存在，请刷新列表' }
          const payload = JSON.parse(target.text) as { done?: unknown; text?: unknown }
          if (typeof payload.text !== 'string' || typeof payload.done !== 'boolean') {
            return { error: 'invalid_item', detail: '待办数据格式无效' }
          }
          if (payload.done === Boolean(done)) return { ok: true }
          await ctx.memory.forget(target.id)
          await ctx.memory.remember(`session:${sessionId}`, 'todo', JSON.stringify({ done: Boolean(done), text: payload.text }), {
            weight: 0.8, authorId: user.id,
          })
          return { ok: true }
        } catch (e) { return { error: 'update_failed', detail: (e as Error).message } }
      },
      async deleteTodo(token: string, sessionId: string, id: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请登录并加入此会话后再操作' }
        try {
          const list = await ctx.memory.recall(`session:${sessionId}`, { kind: 'todo', limit: 100 })
          const target = (Array.isArray(list) ? list : []).find((item) => item.id === String(id))
          if (!target) return { error: 'not_found', detail: '待办已不存在，请刷新列表' }
          await ctx.memory.forget(target.id)
          return { ok: true }
        } catch (e) { return { error: 'delete_failed', detail: (e as Error).message } }
      },
      // 人类「正在输入」实时指示（2026-10-01）：仅会话成员可发出；事件由
      // space-push 按已认证 socket 用户和成员表定向转发，不落库。
      async typing(token: string, sessionId: string, name: string): Promise<void> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return
        ctx.emit('space/typing', { sessionId, name: String(name ?? '') })
      },
      // 表情回应（2026-10-02 修订）：token 鉴权即可 —— 与发言同口径
      // （发言不校验成员，回应也不该卡；否则会出现「能发言不能回应」的怪态）。
      async react(token: string, sessionId: string, eventId: string, emoji: string):
        Promise<ReactSummary[] | { error: string }> {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member' }
        if (!ctx.eventLog.listBySession(sessionId).some((event) => event.id === eventId)) return { error: 'not_found' }
                return ctx.eventLog.react(String(eventId), user.id, String(emoji))
      },
      async unreact(token: string, sessionId: string, eventId: string, emoji: string):
        Promise<ReactSummary[] | { error: string }> {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member' }
        if (!ctx.eventLog.listBySession(sessionId).some((event) => event.id === eventId)) return { error: 'not_found' }
                return ctx.eventLog.unreact(String(eventId), user.id, String(emoji))
      },
      // 整会话全部事件的回应汇总（随 load 一次拉取，时间线渲染不 N+1）。
      async reactions(token: string, sessionId: string):
        Promise<Record<string, ReactSummary[]> | { error: string } | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        if (!ctx.session.getSession(sessionId)) return null
        const ids = ctx.eventLog.listBySession(sessionId).map((e) => e.id)
        return ctx.eventLog.reactions(ids)
      },
      // IM 化：authorId 不再由前端提供 —— 服务端从 token 解析登录身份。
      async send(token: string, sessionId: string, text: string, mentions: string[] = [], replyTo?: string | null) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return { error: 'not_member', detail: '请先登录并加入该会话后再发言' }
        return handleInbound(ctx, sessionId, user.id, text, mentions, replyTo)
      },
    },
  )
}
