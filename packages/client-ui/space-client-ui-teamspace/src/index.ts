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
import type { ReactSummary } from 'space-event'
import { handleInbound } from '../../../../plugins/staging-commands/index.ts'

export const name = 'space-client-ui-teamspace'
// 'memory'：AI 记忆透明面板（memories RPC 经 ctx.memory.recall 读取会话沉淀记忆）。
export const inject = ['webui', 'ui', 'session', 'eventLog', 'staging', 'commands', 'orchestrator', 'users', 'agents', 'memory']

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

/** AgentSnapshot 的客户端视图（前端只显示 id/标题/状态/职责）。 */
interface AgentView { id: string; title: string; status: string; capabilities?: string[] }

export function apply(ctx: Context) {
  ctx.ui.registerPanel({ key: 'space.timeline', slot: 'bottom', title: '时间线', order: 0 })
  ctx.ui.registerPanel({ key: 'space.turn-status', slot: 'right', title: '轮次状态', order: 0 })
  ctx.ui.registerPanel({ key: 'space.members', slot: 'right', title: '成员 / @ 清单', order: 1 })
  ctx.ui.registerPanel({ key: 'space.composer', slot: 'composer', title: '输入区', order: 0 })

  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/teamspace'],
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
      async sessions(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.session.listSessions()
      },
      async commands(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.commands.list().map((c) => ({ name: c.name, usage: c.usage, minArgs: c.minArgs, maxArgs: c.maxArgs }))
      },
      // 消息搜索（FTS/LIKE 已封装在 eventLog store；query 为空直接返回 []）。
      async search(token: string, sessionId: string, query: string): Promise<unknown[] | null> {
        if (!(await auth(ctx, token))) return null
        if (!String(query ?? '').trim()) return []
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.eventLog.search(sessionId, query)
      },
      async events(token: string, sessionId: string) {
        if (!(await auth(ctx, token))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.eventLog.listBySession(sessionId)
      },
      async members(token: string, sessionId: string) {
        if (!(await auth(ctx, token))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      async staging(token: string, sessionId: string) {
        if (!(await auth(ctx, token))) return null
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.staging.list(sessionId)
      },
      async turn(token: string, sessionId: string) {
        if (!(await auth(ctx, token))) return null
        return ctx.orchestrator.turn(sessionId)
      },
      // 2026-10-02：页面宿主是 5174，而后端 HTTP（撤回/上传）在 8080 ——
      // 把后端端口下发给前端，client 用 location.hostname 拼出 apiBase。
      async apiPort(token: string) {
        return (await auth(ctx, token)) ? Number(process.env.APP_PORT ?? 8080) : null
      },
      // AI 记忆透明面板（2026-10-01）：读取本会话沉淀的记忆（最多 10 条）。
      // memory 服务未就绪 / recall 抛错时返回 []（面板显示「暂无沉淀记忆」）。
      // 人类用户名映射（消息作者显示名用 —— 成员表缺行时兜底）。
      async humans(token: string) {
        if (!(await auth(ctx, token))) return []
        return ctx.users.listHumans()
      },
      async memories(token: string, sessionId: string): Promise<Array<{ text: string }> | null> {
        if (!(await auth(ctx, token))) return null
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
        if (!(await auth(ctx, token))) return null
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
      // 人类「正在输入」实时指示（2026-10-01）：token 校验通过后直接经本包
      // 所在的 webui 广播 'space:typing'（不落库、无返回 —— 瞬时信号零持久化）。
      // 前端自行做 3s 超时消隐与节流，服务端只做转发。
      async typing(token: string, sessionId: string, name: string): Promise<void> {
        if (!(await auth(ctx, token))) return
        ctx.webui.broadcast('space:typing', { sessionId, name: String(name ?? '') })
      },
      // 表情回应（2026-10-02 修订）：token 鉴权即可 —— 与发言同口径
      // （发言不校验成员，回应也不该卡；否则会出现「能发言不能回应」的怪态）。
      async react(token: string, sessionId: string, eventId: string, emoji: string):
        Promise<ReactSummary[] | { error: string }> {
        const user = await auth(ctx, token)
        if (!user) return { error: 'unauthorized' }
                return ctx.eventLog.react(String(eventId), user.id, String(emoji))
      },
      async unreact(token: string, sessionId: string, eventId: string, emoji: string):
        Promise<ReactSummary[] | { error: string }> {
        const user = await auth(ctx, token)
        if (!user) return { error: 'unauthorized' }
                return ctx.eventLog.unreact(String(eventId), user.id, String(emoji))
      },
      // 整会话全部事件的回应汇总（随 load 一次拉取，时间线渲染不 N+1）。
      async reactions(token: string, sessionId: string):
        Promise<Record<string, ReactSummary[]> | { error: string } | null> {
        if (!(await auth(ctx, token))) return null
        if (!ctx.session.getSession(sessionId)) return null
        const ids = ctx.eventLog.listBySession(sessionId).map((e) => e.id)
        return ctx.eventLog.reactions(ids)
      },
      // IM 化：authorId 不再由前端提供 —— 服务端从 token 解析登录身份。
      async send(token: string, sessionId: string, text: string, mentions: string[] = [], replyTo?: string | null) {
        const user = await auth(ctx, token)
        if (!user) return { error: 'unauthorized', detail: '请先登录后再发言' }
        return handleInbound(ctx, sessionId, user.id, text, mentions, replyTo)
      },
    },
  )
}
