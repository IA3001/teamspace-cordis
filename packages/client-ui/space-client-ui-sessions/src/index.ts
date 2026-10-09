// space-client-ui-sessions —— 左侧会话栏（2026-09-29 团队空间改版，纯新增包）。
//
// 入驻形态（铁律 4 精神「入驻 = 纯新增」）：本包不注册页面（不新增菜单项），
// client 侧经外壳原生通道 ctx.client.router.slot({ type, component }) 把
// 会话栏组件挂到 'space-teamspace-sidebar' 槽位；整页（space-client-ui-
// teamspace）在左区渲染 <k-slot name="space-teamspace-sidebar" single>——
// 页面只认槽位名，不 import 本包；本包停用 = 槽位无视图 = 页面左区自然收空，
// 既有文件零改动。Panel 描述符照旧登记进 ctx.ui（台账可查，GET /api/panels）。
//
// 鉴权口径（IM 化改造 2026-09-30）：RPC 方法首参均为 token
// （localStorage 'space_token'，由 /login 页写入）；token 无效统一返回
// null / 空数组，由前端静默跳登录。verifyToken 抛错 = 未登录，不往上炸。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type { PublicUser } from 'space-identity'
import { isRole } from 'space-session'
import type { Role } from 'space-session'
import { randomUUID } from 'node:crypto'

export const name = 'space-client-ui-sessions'
// cordis 严格注入（P4 教训：RPC 数据函数里摸到的每个服务都要进 inject）：
// agents 是 Agent 名册（内置与自定义 Agent 都从同一注册表多选）；users 是 IM 化
// 新增 —— verifyToken / listHumans；eventLog 是聊天列表「最近消息摘要」新增。
export const inject = ['webui', 'ui', 'session', 'agents', 'users', 'eventLog']

/** token → 用户；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string): Promise<PublicUser | null> {
  try {
    return await ctx.users.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

function isMember(ctx: Context, sessionId: string, principalId: string): boolean {
  try { return ctx.session.listMembers(sessionId, true).some((member) => member.principalId === principalId) }
  catch { return false }
}

/** 群管理权限闸门：操作者必须是该会话在册的 群主/管理员；否则返回结构化拒绝。 */
function notGroupAdmin(ctx: Context, sessionId: string, userId: string): { error: string; detail: string } | null {
  const me = ctx.session.listMembers(sessionId, true).find((m) => m.principalId === userId)
  if (me && (me.role === '群主' || me.role === '管理员')) return null
  return { error: 'forbidden', detail: '只有群主 / 管理员可以管理成员或结束会议' }
}

/**
 * 建会入册（P8 原语义，保留导出供 verify-p8 直调）：建会（open）→ 当前身份
 * （u_dri）以 DRI 入册 → 兼容旧版固定角色名册 → selectedIds 中已注册的 Agent
 * 以自身身份入会（role='成员'，duty 用名册 title 作展示名）。
 */
export function createSessionWithRoster(ctx: Context, selectedIds: readonly string[] = []) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const title = `新会议 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const session = ctx.session.createSession({ title })
  const sid = session.id
  ctx.session.join({ sessionId: sid, principalId: 'u_dri', role: 'DRI', duty: '决策与审批' })
  ctx.session.join({ sessionId: sid, principalId: 'a_coordinator', role: '协调者', duty: '调度（不参与调用链）' })
  ctx.session.join({ sessionId: sid, principalId: 'a_analyst', role: '需求分析师' })
  ctx.session.join({ sessionId: sid, principalId: 'a_challenger', role: '挑战者' })
  ctx.session.join({ sessionId: sid, principalId: 'a_recorder', role: '会议记录官' })
  joinSelectedAgents(ctx, sid, selectedIds)
  return session
}

/** 统一 Agent 注册表中的已选 Agent 入会；自定义 Agent 无需 kind 特判。 */
function joinSelectedAgents(ctx: Context, sid: string, ids: readonly string[]) {
  const roster = new Map(ctx.agents.list().map((a) => [a.descriptor.id, a.descriptor]))
  for (const id of ids) {
    const d = roster.get(id)
    if (d) ctx.session.join({ sessionId: sid, principalId: d.id, role: '成员', duty: d.title })
  }
}

/**
 * 建群会（IM 化，2026-09-30）：建会（title 可空 → 服务端默认命名）→ 当前
 * 登录用户以 role='群主' 入册 → 已选 Agent 通过统一名册入会 →
 * userIds 里的成员逐个 join（role='成员'）→ 返回新会话。
 * 独立导出：create（兼容入口）与运行时走同一条代码路径。
 */
export function createGroupSession(
  ctx: Context,
  user: PublicUser,
  title: string,
  userIds: readonly string[] = [],
  agentIds: readonly string[] = [],
) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const finalTitle = title.trim() ||
    `新会议 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const session = ctx.session.createSession({ title: finalTitle })
  const sid = session.id
  // 群主 = 会话创建者（IM 语义：群主/管理员可邀请移除成员）。
  ctx.session.join({ sessionId: sid, principalId: user.id, role: '群主', duty: user.displayName })
  // coding Agent 和自定义 Agent 都走同一注册表与会话成员模型。
  joinSelectedAgents(ctx, sid, agentIds)
  // 受邀人类逐个入会（role='成员'；duty 缺省空串）。
  for (const uid of userIds) {
    if (uid === user.id) continue // 群主已入册，跳过自己
    ctx.session.join({ sessionId: sid, principalId: uid, role: '成员' })
  }
  ctx.eventLog.append({
    id: randomUUID(), sessionId: sid, authorId: null, authorKind: 'system', kind: 'system',
    phaseId: null,
    text: `会话由 ${user.displayName} 创建；初始成员：${[user.id, ...agentIds, ...userIds.filter((id) => id !== user.id)].join('、')}。受邀成员可读取完整会话历史。`,
    mentions: [], toolCalls: [], replyMode: '',
  })
  return session
}

/** Leave a durable membership row and add the removal record to the shared timeline. */
export async function removeSessionMember(ctx: Context, sessionId: string, principalId: string,
  actorId: string, actorName: string) {
  const targetUser = await ctx.users.byId(principalId)
  const targetAgent = ctx.agents.list().find((agent) => agent.descriptor.id === principalId)
  const targetName = targetUser?.displayName || targetAgent?.descriptor.title || principalId
  ctx.session.leave(sessionId, principalId)
  ctx.eventLog.append({
    id: randomUUID(), sessionId, authorId: null, authorKind: 'system', kind: 'system', phaseId: null,
    text: `${actorName}（${actorId}）将 ${targetName}（${principalId}）移出会话。`,
    mentions: [], toolCalls: [], replyMode: '',
  })
  return ctx.session.listMembers(sessionId, true)
}

/** Change a human member's session role and append one attributable timeline event. */
export async function changeSessionMemberRole(ctx: Context, sessionId: string, principalId: string,
  roleInput: unknown, actorId: string, actorName: string) {
  const target = await ctx.users.byId(principalId)
  if (!target || target.kind !== 'human') {
    return { error: 'invalid_member', detail: '只能调整已入会的人类成员角色' }
  }
  if (typeof roleInput !== 'string' || !isRole(roleInput) || !['成员', 'DRI', '管理员'].includes(roleInput)) {
    return { error: 'invalid_role', detail: '会话成员角色只能设置为普通成员、DRI 或管理员' }
  }
  const members = ctx.session.listMembers(sessionId, true)
  const current = members.find((member) => member.principalId === principalId)
  if (!current) return { error: 'not_found', detail: '该成员当前不在会话中' }
  if (current.role === '群主') return { error: 'forbidden', detail: '群主角色固定归会话创建者，不能在此变更' }
  const nextRole = roleInput as Role
  if (current.role === nextRole) return members
  try {
    ctx.session.setRole(sessionId, principalId, nextRole)
  } catch (error) {
    return { error: (error as { code?: string }).code ?? 'role_change_failed', detail: (error as Error).message }
  }
  ctx.eventLog.append({
    id: randomUUID(), sessionId, authorId: null, authorKind: 'system', kind: 'system', phaseId: null,
    text: `${actorName}（${actorId}）将 ${target.displayName}（${principalId}）的会话角色从「${current.role}」调整为「${nextRole}」。`,
    mentions: [], toolCalls: [], replyMode: '',
  })
  return ctx.session.listMembers(sessionId, true)
}

export function apply(ctx: Context) {
  ctx.ui.registerPanel({ key: 'space.sessions', slot: 'left', title: '会话栏', order: 0 })

  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
    },
    {
      /** 当前登录用户（verifyToken → PublicUser）；无效返回 null。 */
      async me(token: string) {
        return auth(ctx, token)
      },
      async sessions(token: string) {
        const viewer = await auth(ctx, token)
        if (viewer?.kind !== 'human') return null
        return ctx.session.listSessions().filter((session) => isMember(ctx, session.id, viewer.id))
      },
      /** 聊天列表「最近一条消息」摘要（微信式列表的数据源）：
       *  每个会话取时间线最后一条事件（可能是消息/系统事件）。
       *  authorName：服务端就地解析的作者显示名（会话名册 duty/role/id），
       *  系统事件（authorId null）→「系统」；客户端不建成员映射。 */
      /** 会话摘要 + 未读数（B1，2026-10-06）：seen 是客户端传来的
       *  { 会话id: 已读时刻ms } —— 服务端按「本人消息以外的 message 事件
       *  晚于已读时刻」计数。seen 缺省 = 全部 0（不过从未上报过就全算未读
       *  会误伤新设备，所以 seen 键缺失时未读记 0，保持红点语义由 ts 比对
       *  在客户端兜底）。 */
      async summaries(token: string, seen?: Record<string, number>) {
        const viewer = await auth(ctx, token)
        if (viewer?.kind !== 'human') return null
        return ctx.session.listSessions().filter((s) => isMember(ctx, s.id, viewer.id)).map((s) => {
          const list = ctx.eventLog.listBySession(s.id)
          const last = list[list.length - 1]
          // 就地解析作者名：该会话在册成员里按 principalId 找 duty/role；
          // 找不到（已退会/未入册）兜底显示 id 本身。
          const members = ctx.session.listMembers(s.id, true)
          const m = last?.authorId ? members.find((x) => x.principalId === last.authorId) : undefined
          const authorName = !last?.authorId
            ? '系统'
            : (m?.duty || m?.role || last.authorId)
          const seenTs = seen?.[s.id]
          const unreadCount = typeof seenTs === 'number'
            ? list.filter((e) =>
                e.kind === 'message' && !e.voided && e.authorId !== viewer.id &&
                (Date.parse(e.ts) || 0) > seenTs).length
            : 0
          // @我 计数（A5，2026-10-06）：已读时刻之后、mentions 命中本人 id
          // 或正文 @本人用户名/显示名 的消息数 —— 离线也能知道「有人点名我」。
          const atMe = (e: { mentions?: unknown; text: string; authorId: string | null }) => {
            if (e.authorId === viewer.id) return false
            const ms = Array.isArray(e.mentions) ? e.mentions.map(String) : []
            if (ms.includes(viewer.id)) return true
            const lower = e.text.toLowerCase()
            return lower.includes(`@${viewer.username.toLowerCase()}`) ||
              (viewer.displayName && lower.includes(`@${viewer.displayName.toLowerCase()}`))
          }
          // @我 兜底（A5）：无已读记录（新设备）也提醒 —— 回看 7 天内的 @我。
          const mentionsSince = typeof seenTs === 'number' ? seenTs : Date.now() - 7 * 86_400_000
          const mentionsCount = list.filter((e) => e.kind === 'message' && !e.voided &&
            (Date.parse(e.ts) || 0) > mentionsSince && atMe(e)).length
          return {
            sessionId: s.id,
            text: last?.text ?? '',
            ts: last?.ts ?? s.updatedAt,
            authorKind: last?.authorKind ?? 'system',
            authorId: last?.authorId ?? null,
            authorName,
            unreadCount,
            mentionsCount,
          }
        })
      },
      async members(token: string, sessionId: string) {
        const viewer = await auth(ctx, token)
        if (viewer?.kind !== 'human' || !isMember(ctx, sessionId, viewer.id)) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      /** 统一 Agent 名册：新建会话可直接邀请内置或团队自定义 Agent。 */
      async agentRoster(token: string) {
        const user = await auth(ctx, token)
        if (user?.kind !== 'human') return []
        return ctx.agents.list().map((a) => ({
          id: a.descriptor.id,
          title: a.descriptor.title,
          promptRef: a.descriptor.promptRef ?? null,
        }))
      },
      /** 兼容入口（P8 语义）：建会 + 群主/协调者/会议 bot 默认名册 + coding 多选。
       *  内部改走 createGroupSession —— 群主 = 当前登录用户。 */
      async create(token: string, selectedIds: string[] = []) {
        const user = await auth(ctx, token)
        if (user?.kind !== 'human') return null
        return createGroupSession(ctx, user, '', [], selectedIds)
      },
      /** 全部人类用户（「邀请成员」多选的数据源），按创建时间升序。 */
      async listHumans(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.users.listHumans()
      },
      /** 建群会：标题（可空 → 默认命名）+ 受邀成员 + Agent 多选。 */
      async createGroup(token: string, title: string, userIds: string[] = [], agentIds: string[] = []) {
        const user = await auth(ctx, token)
        if (user?.kind !== 'human') return null
        return createGroupSession(ctx, user, String(title ?? ''), userIds, agentIds)
      },
      /** 邀请成员：逐个 join（role='成员'）。仅群主/管理员可操作；会话不存在
       *  或无权返回 null / {error:'forbidden'}（IM 语义：群主/管理员管理成员）。 */
      async invite(token: string, sessionId: string, userIds: string[] = []) {
        const user = await auth(ctx, token)
        if (!user) return null
        if (!ctx.session.getSession(sessionId)) return null
        const denied = notGroupAdmin(ctx, sessionId, user.id)
        if (denied) return denied
        for (const uid of userIds) {
          const wasActive = ctx.session.listMembers(sessionId, true).some((member) => member.principalId === uid)
          ctx.session.join({ sessionId, principalId: uid, role: '成员' })
          if (wasActive) continue
          // 新成员欢迎（2026-10-01）：每人落一条系统事件。eventLog.append 内部
          // 会 emit 'space/event-appended' → 自动广播，前端即时可见，无需额外推送。
          // 只在 invite 落欢迎、createGroup 不落：建群时若连落多条系统事件会刷屏，
          // 受邀者进会自然能看到既有时间线。
          const invitedUser = await ctx.users.byId(uid)
          const displayName = invitedUser?.displayName ?? uid
          ctx.eventLog.append({
            id: randomUUID(),
            sessionId,
            authorId: null,
            authorKind: 'system',
            kind: 'system',
            phaseId: null,
            text: `${user.displayName} 邀请 ${displayName}（${uid}）加入会议；该成员可读取完整会话历史。`,
            mentions: [],
            toolCalls: [],
            replyMode: '',
          })
        }
        return ctx.session.listMembers(sessionId, true)
      },
      /** 移除成员：保留成员状态并追加操作者/目标事件。仅群主/管理员可操作。 */
      async removeMember(token: string, sessionId: string, principalId: string) {
        const user = await auth(ctx, token)
        if (!user) return null
        if (!ctx.session.getSession(sessionId)) return null
        const denied = notGroupAdmin(ctx, sessionId, user.id)
        if (denied) return denied
        if (ctx.session.listMembers(sessionId, true).some((member) =>
          member.principalId === principalId && member.role === '群主')) {
          return { error: 'forbidden', detail: '不能移除会话群主' }
        }
        return removeSessionMember(ctx, sessionId, String(principalId), user.id, user.displayName)
      },
      /** Change human session roles; group admins manage membership while DRI remains a separate decision role. */
      async setMemberRole(token: string, sessionId: string, principalId: string, role: unknown) {
        const user = await auth(ctx, token)
        if (!user) return null
        if (!ctx.session.getSession(sessionId)) return null
        const denied = notGroupAdmin(ctx, sessionId, user.id)
        if (denied) return denied
        return changeSessionMemberRole(ctx, sessionId, String(principalId), role, user.id, user.displayName)
      },
      /** 登出：删除服务端 token（前端同时清 localStorage）。 */
      async logout(token: string) {
        try { await ctx.users.logout(token) } catch { /* 幂等 */ }
        return true
      },
      /** 结束会议：ctx.session.closeSession（幂等）。仅群主/管理员可操作。 */
      async close(token: string, sessionId: string) {
        const user = await auth(ctx, token)
        if (!user) return null
        if (!ctx.session.getSession(sessionId)) return null
        const denied = notGroupAdmin(ctx, sessionId, user.id)
        if (denied) return denied
        return ctx.session.closeSession(sessionId)
      },
    },
  )
}
