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
import { isAgentVisibleEvent } from 'space-event'
import { AgentCatalogError } from 'space-agent-catalog'
import type { AgentDefinition, AgentDefinitionInput, AgentDefinitionPatch } from 'space-agent-catalog'
import type { PromptTemplate } from 'space-prompt'
import { randomUUID } from 'node:crypto'
import { handleInbound } from '../../../../plugins/staging-commands/index.ts'

export const name = 'space-client-ui-teamspace'
// 'memory'：AI 记忆透明面板（memories RPC 经 ctx.memory.recall 读取会话沉淀记忆）。
export const inject = ['webui', 'ui', 'session', 'eventLog', 'staging', 'commands', 'orchestrator', 'users', 'agents', 'agentCatalog', 'prompts', 'settings', 'memory', 'sessionWork', 'tools']

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
        promptRef: old.promptRef || '', modelRef: '', toolIds: [],
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
    text: `已邀请 Agent「${title}」加入会话（邀请者 ${inviterId}；可访问完整历史）`,
    mentions: [], toolCalls: [], replyMode: '',
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
interface AgentView { id: string; title: string; status: string; capabilities?: string[] }

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
      routes: ['/teamspace', '/teamspace/agents'],
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
          capabilities: [...a.descriptor.capabilities],
        }))
      },
      /** Shared Agent definitions: any Team human may view and configure them. */
      async agentDefinitions(token: string): Promise<AgentDefinition[] | null> {
        if (!(await authTeamHuman(ctx, token))) return null
        return ctx.agentCatalog.list()
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
      /** Explicit invitation grants this Agent the full existing event history. */
      async inviteAgent(token: string, sessionId: string, agentId: string) {
        const user = await sessionMember(ctx, String(token ?? ''), String(sessionId ?? ''))
        if (!user) return null
        try {
          const result = inviteAgentToSession(ctx, String(sessionId), String(agentId), user.id)
          return { ok: true, joined: result.joined, title: result.title, detail: `已邀请「${result.title}」；加入后可访问完整会话历史` }
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
      async commands(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.commands.list().map((c) => ({ name: c.name, usage: c.usage, minArgs: c.minArgs, maxArgs: c.maxArgs }))
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
        return ctx.eventLog.listBySession(sessionId)
      },
      async event(token: string, sessionId: string, eventId: string): Promise<SessionEvent | null> {
        if (!(await sessionMember(ctx, String(token ?? ''), String(sessionId ?? '')))) return null
        return ctx.eventLog.listBySession(sessionId).find((event) => event.id === eventId) ?? null
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
      // 团队待办（2026-10-01）：读取本会话 /todo 的待办（存记忆层 kind='todo'）。
      // 解析 text JSON（{done,text}）；解析失败的脏条目直接跳过。序号不在这里
      // 编 —— 前端按 createdAt 升序自行编号（与 /todo 指令同口径）。
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
