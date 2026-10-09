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
import { randomUUID } from 'node:crypto'

export const name = 'space-client-ui-sessions'
// cordis 严格注入（P4 教训：RPC 数据函数里摸到的每个服务都要进 inject）：
// agents 是 P8 新增 —— coding 名册（多选数据源 + 入会解析）；users 是 IM 化
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

/** 群管理权限闸门：操作者必须是该会话在册的 群主/管理员；否则返回结构化拒绝。 */
function notGroupAdmin(ctx: Context, sessionId: string, userId: string): { error: string; detail: string } | null {
  const me = ctx.session.listMembers(sessionId, true).find((m) => m.principalId === userId)
  if (me && (me.role === '群主' || me.role === '管理员')) return null
  return { error: 'forbidden', detail: '只有群主 / 管理员可以管理成员或结束会议' }
}

/**
 * 建会入册（P8 原语义，保留导出供 verify-p8 直调）：建会（open）→ 当前身份
 * （u_dri）以 DRI 入册 → 默认名册（协调者 + 会议三机器人，与 seed/0001 口径
 * 一致）→ selectedIds 里的 coding 角色以本 id 入会（role='成员'，duty 用名册
 * title 作展示名）。名册外 id 忽略，不炸。
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
  joinCoding(ctx, sid, selectedIds)
  return session
}

/** coding agent 照旧 join（P8 语义原样：role='成员'，duty=名册 title）。 */
function joinCoding(ctx: Context, sid: string, ids: readonly string[]) {
  const roster = new Map(ctx.agents.list('coding').map((a) => [a.descriptor.id, a.descriptor]))
  for (const id of ids) {
    const d = roster.get(id)
    if (d) ctx.session.join({ sessionId: sid, principalId: d.id, role: '成员', duty: d.title })
  }
}

/**
 * 建群会（IM 化，2026-09-30）：建会（title 可空 → 服务端默认命名）→ 当前
 * 登录用户以 role='群主' 入册 → coding agent 照旧 join（P8 名册语义）→
 * userIds 里的成员逐个 join（role='成员'）→ 返回新会话。
 * 独立导出：create（兼容入口）与运行时走同一条代码路径。
 */
export function createGroupSession(
  ctx: Context,
  user: PublicUser,
  title: string,
  userIds: readonly string[] = [],
  codingIds: readonly string[] = [],
) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const finalTitle = title.trim() ||
    `新会议 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const session = ctx.session.createSession({ title: finalTitle })
  const sid = session.id
  // 群主 = 会话创建者（IM 语义：群主/管理员可邀请移除成员）。
  ctx.session.join({ sessionId: sid, principalId: user.id, role: '群主', duty: user.displayName })
  // coding agent 照旧 join（P8 名册语义）。
  joinCoding(ctx, sid, codingIds)
  // 受邀人类逐个入会（role='成员'；duty 缺省空串）。
  for (const uid of userIds) {
    if (uid === user.id) continue // 群主已入册，跳过自己
    ctx.session.join({ sessionId: sid, principalId: uid, role: '成员' })
  }
  return session
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
        if (!(await auth(ctx, token))) return null
        return ctx.session.listSessions()
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
        if (!viewer) return null
        return ctx.session.listSessions().map((s) => {
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
        if (!(await auth(ctx, token))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      /** coding 名册（P8）：新会议「附加角色」多选的数据源（title 展示，id 入会）。 */
      async codingRoster(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.agents.list('coding').map((a) => ({
          id: a.descriptor.id,
          title: a.descriptor.title,
          promptRef: a.descriptor.promptRef ?? null,
        }))
      },
      /** 兼容入口（P8 语义）：建会 + 群主/协调者/会议 bot 默认名册 + coding 多选。
       *  内部改走 createGroupSession —— 群主 = 当前登录用户。 */
      async create(token: string, selectedIds: string[] = []) {
        const user = await auth(ctx, token)
        if (!user) return null
        return createGroupSession(ctx, user, '', [], selectedIds)
      },
      /** 全部人类用户（「邀请成员」多选的数据源），按创建时间升序。 */
      async listHumans(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.users.listHumans()
      },
      /** 建群会：标题（可空 → 默认命名）+ 受邀成员 + coding 角色多选。 */
      async createGroup(token: string, title: string, userIds: string[] = [], codingIds: string[] = []) {
        const user = await auth(ctx, token)
        if (!user) return null
        return createGroupSession(ctx, user, String(title ?? ''), userIds, codingIds)
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
          ctx.session.join({ sessionId, principalId: uid, role: '成员' })
          // 新成员欢迎（2026-10-01）：每人落一条系统事件。eventLog.append 内部
          // 会 emit 'space/event-appended' → 自动广播，前端即时可见，无需额外推送。
          // 只在 invite 落欢迎、createGroup 不落：建群时若连落多条系统事件会刷屏，
          // 受邀者进会自然能看到既有时间线。
          const displayName = ctx.users.byId(uid)?.displayName ?? uid
          ctx.eventLog.append({
            id: randomUUID(),
            sessionId,
            authorId: null,
            authorKind: 'system',
            kind: 'system',
            text: `欢迎 ${displayName} 加入会议 —— 可以在成员面板 @ta`,
            mentions: [],
            toolCalls: [],
            replyMode: '',
          })
        }
        return ctx.session.listMembers(sessionId, true)
      },
      /** 移除成员：ctx.session.leave。仅群主/管理员可操作。 */
      async removeMember(token: string, sessionId: string, principalId: string) {
        const user = await auth(ctx, token)
        if (!user) return null
        if (!ctx.session.getSession(sessionId)) return null
        const denied = notGroupAdmin(ctx, sessionId, user.id)
        if (denied) return denied
        ctx.session.leave(sessionId, principalId)
        return ctx.session.listMembers(sessionId, true)
      },
      /** 登出：删除服务端 token（前端同时清 localStorage）。 */
      async logout(token: string) {
        try { await ctx.users.logout(token) } catch { /* 幂等 */ }
        return true
      },
      /** 调试控制台端口（账号管理页 /admin 宿主在 5172）。 */
      async debugPort(token: string) {
        if (!(await auth(ctx, token))) return null
        return Number(process.env.DEBUG_PORT ?? 5172)
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
