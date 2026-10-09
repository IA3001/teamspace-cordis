// space-client-ui-agents —— Agent 配置页（2026-10-05 新增包）。
//
// 入驻：挂 **5172 调试控制台**，routes ['/agents']；不走 HTTP —— 全部数据
// 方法走 webui RPC（与 admin / models 页同款口径；isolate 不写，消费
// debug-webui 的无名 webui 实例）。
//
// 功能（实事求是，只放真生效的配置）：
//   1. 名册：全部入驻 agent（meeting + coding）的 id / 标题 / 类别 / 能力 /
//      生命周期状态 / promptRef。
//   2. 提示词模板：list / 编辑 upsert（ctx.prompts，P8 内容资产）——
//      会议 agent 下一回合组装（L4）即用新文案。
//   3. per-agent promptRef 重定向：settings 键 agent.<id>.promptRef
//      （agent-analyst-llm 每回合现读，改完即生效）。
//   4. 自治预算：settings 键 agent.autonomyBudget（orchestrator 每次闸门
//      现读，改完即生效）。
//
// 权限口径：所有 data 方法首参 token，verifyToken 成功且 isAdmin 才放行。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type { PublicUser } from 'space-identity'
import { IdentityError } from 'space-identity'
import type { DelegatePayload } from 'space-orchestrator'

export const name = 'space-client-ui-agents'
export const inject = ['webui', 'users', 'agents', 'prompts', 'settings', 'llm', 'session', 'messages', 'orchestrator']

/** 自定义 Agent：职责是**自由文本**（完全可定制），入会角色固定「成员」，
 *  授权走标题（orchestrator 把自定义标题并入授权名单，2026-10-07）。 */
interface CustomAgent { id: string; title: string; roleLabel: string; promptRef: string }
const listCustom = (ctx: Context): CustomAgent[] => ctx.settings.get<CustomAgent[]>('agent.custom', [])

/** 给自定义会议 Agent 挂 LLM 委托应答（与 agent-analyst-llm 同款语义）。 */
function attachDelegateHandler(ctx: Context, a: CustomAgent) {
  ctx.on('orchestrator/delegate', (p: DelegatePayload) => {
    if (p.target !== a.title && p.target !== a.id) return
    // 整体兜底：应答器任何异常都不能炸进程（2026-10-07 实测 unhandled
    // rejection 直接杀掉服务进程）。
    void (async () => {
      const duty = a.roleLabel ? `你的职责：${a.roleLabel}。` : ''
      let system = `你是「${a.title}」——会议中的专属成员。${duty}基于会议上下文履行职责，回答简洁、给结论与依据。`
      try {
        const tpl = ctx.prompts.get(a.promptRef || `prompt.${a.id}`)
        if (tpl && !tpl.body.includes('【占位提示词')) system = tpl.body
      } catch { /* 未绑定模板 → 用缺省 system */ }
      if (!ctx.llm.configured) {
        ctx.orchestrator.reportFeedback(p.sessionId, a.title, '（占位）LLM 未配置，已留痕待命')
        return
      }
      try {
        const text = await ctx.llm.chat([
          { role: 'system', content: system },
          { role: 'user', content: `会议委托：${p.instruction}\n请以「${a.title}」的职责给出回应。` },
        ])
        ctx.orchestrator.reportFeedback(p.sessionId, a.title, `【真模型】${text || '（空输出）'}`)
      } catch (e) {
        ctx.orchestrator.reportFeedback(p.sessionId, a.title, `（失败）${(e as Error).message}`)
      }
    })().catch((e) => console.error(`[agents] 委托应答异常：${(e as Error).message}`))
  })
}

/** 自定义 Agent 注册 + 入会（全部 open 会话）+ 挂委托应答。 */
function activateCustom(ctx: Context, a: CustomAgent) {
  // 兜底补建 AI 身份（老数据建 Agent 时 users 行缺失 → join 外键炸）。
  try { ctx.users.registerAgent(a.id, a.title) } catch { /* 已存在 */ }
  try {
    ctx.agents.register({ id: a.id, kind: 'meeting', title: a.title, promptRef: a.promptRef || undefined, capabilities: ['custom'] })
  } catch { /* duplicate —— boot 与热创建竞态，幂等跳过 */ }
  attachDelegateHandler(ctx, a)
  for (const s of ctx.session.listSessions()) {
    if (s.status !== 'open') continue
    try {
      ctx.session.join({ sessionId: s.id, principalId: a.id, role: '成员', duty: a.title })
    } catch (e) {
      console.error(`[agents] 自定义 Agent「${a.title}」加入会话 ${s.id} 失败：${(e as Error).message}`)
    }
  }
}

/** token → PublicUser；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string): Promise<PublicUser | null> {
  try {
    return await ctx.users.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

/** IdentityError → { error, detail } 结构化失败（前端直接展示）。 */
function fail(e: unknown): { error: string; detail: string } {
  if (e instanceof IdentityError) return { error: e.code, detail: e.message }
  return { error: 'internal', detail: e instanceof Error ? e.message : String(e) }
}

export function apply(ctx: Context) {
  // boot：激活持久化的自定义 Agent（/agents 页创建，settings 持久化）。
  const customs = listCustom(ctx)
  for (const a of customs) activateCustom(ctx, a)
  console.log(`[agents] 自定义应答器已挂载 ${customs.length} 个：${customs.map((a) => a.title).join('、') || '（无）'}`)

  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/agents'],
    },
    {
      /** 当前登录用户（verifyToken）；页面据此判断 isAdmin。 */
      async me(token: string) {
        return auth(ctx, token)
      },

      /** 登录（拒绝态就地登录用）。 */
      async login(username: string, password: string) {
        try {
          const grant = await ctx.users.login(username, password)
          return { token: grant.token }
        } catch (e) {
          const err = e as { code?: string; message?: string }
          return { error: err.code ?? 'login_failed', detail: err.message ?? '登录失败' }
        }
      },

      /** 名册 + 提示词 + 预算 + LLM 可用性（一次拉全，页面单请求渲染）。 */
      async getConfig(token: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        const s = ctx.settings
        return {
          roster: ctx.agents.list().map((a) => ({
            id: a.descriptor.id,
            kind: a.descriptor.kind,
            title: a.descriptor.title,
            capabilities: [...a.descriptor.capabilities],
            promptRef: a.descriptor.promptRef ?? '',
            status: a.status,
            /** per-agent promptRef 重定向（settings 现值；空 = 用描述符缺省）。 */
            promptOverride: s.get<string>(`agent.${a.descriptor.id}.promptRef`, ''),
            /** 自定义 Agent 的职责描述（自由文本）。 */
            roleLabel: s.get<CustomAgent[]>('agent.custom', []).find((c) => c.id === a.descriptor.id)?.roleLabel ?? '',
          })),
          prompts: ctx.prompts.list(),
          budget: s.get<number>('agent.autonomyBudget', 0),
          llmConfigured: ctx.llm.configured,
        }
      },

      /** upsert 提示词模板（整体替换 title/body；ref 幂等）。 */
      async savePrompt(token: string, ref: string, title: string, body: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        if (!ref.trim() || !title.trim() || !body.trim()) {
          return { error: 'empty_field', detail: 'ref / 标题 / 正文都不能为空' }
        }
        try {
          const t = ctx.prompts.upsert(ref.trim(), title.trim(), body)
          return { ok: true, detail: `已保存：${t.ref}（${new Date(t.updatedAt).toLocaleString('zh-CN')}）` }
        } catch (e) {
          return fail(e)
        }
      },

      /** per-agent promptRef 重定向（空串 = 清除重定向，回描述符缺省）。 */
      async saveAgentPrompt(token: string, agentId: string, promptRef: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        const key = `agent.${String(agentId)}.promptRef`
        if (!String(promptRef).trim()) {
          ctx.settings.set(key, undefined)
          return { ok: true, detail: `${agentId} 的提示词重定向已清除` }
        }
        // 防呆：ref 必须已存在（upsert 过的模板）——打错字当场拦下。
        try {
          ctx.prompts.get(String(promptRef).trim())
        } catch {
          return { error: 'prompt_missing', detail: `模板 ${promptRef} 不存在 —— 先在下方保存该 ref` }
        }
        ctx.settings.set(key, String(promptRef).trim())
        return { ok: true, detail: `${agentId} 下一回合改用 ${promptRef}` }
      },

      /** 新建自定义会议 Agent（A-反馈①）：id 自动生成，入全部 open 会话。 */
      async createAgent(token: string, cfg: { title: string; roleLabel?: string; promptRef?: string }) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        const title = String(cfg.title ?? '').trim()
        const roleLabel = String(cfg.roleLabel ?? '').trim().slice(0, 60)
        if (!title) return { error: 'empty_title', detail: '标题不能为空（标题即 @ 目标，请用独特命名）' }
        const custom = listCustom(ctx)
        if (custom.some((a) => a.title === title)) {
          return { error: 'duplicate_title', detail: `已有名为「${title}」的 Agent` }
        }
        const id = `a_custom_${custom.length + 1}_${Date.now().toString(36).slice(-4)}`
        const a: CustomAgent = { id, title, roleLabel, promptRef: String(cfg.promptRef ?? '').trim() }
        // 先建 AI 身份（users 表，供 session_members 外键引用），失败即中止。
        try {
          ctx.users.registerAgent(a.id, title)
        } catch (e) {
          return { error: 'identity_failed', detail: (e as Error).message }
        }
        custom.push(a)
        ctx.settings.set('agent.custom', custom)
        activateCustom(ctx, a)
        return { ok: true, detail: `已创建并加入全部进行中会议：${title}（@${title} 可召唤）` }
      },

      /** 删除自定义会议 Agent（退会 + 注销 + 移除持久化）。 */
      async removeAgent(token: string, id: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        const custom = listCustom(ctx)
        const a = custom.find((x) => x.id === String(id))
        if (!a) return { error: 'not_found', detail: '只支持删除在此页创建的自定义 Agent' }
        ctx.settings.set('agent.custom', custom.filter((x) => x.id !== a.id))
        try { ctx.agents.unregister(a.id) } catch { /* 幂等 */ }
        try { ctx.users.removeUser(a.id) } catch { /* 幂等 */ }
        for (const s of ctx.session.listSessions()) {
          try { ctx.session.leave(s.id, a.id) } catch { /* 幂等 */ }
        }
        return { ok: true, detail: `已删除 ${a.title}` }
      },

      /** 自治预算（>0 生效；0 = 回启动 Config 缺省）。 */
      async saveBudget(token: string, budget: number) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        const n = Math.floor(Number(budget))
        if (!Number.isFinite(n) || n < 0 || n > 50) {
          return { error: 'invalid_budget', detail: '预算需在 0–50 之间（0 = 用缺省 8）' }
        }
        if (n === 0) ctx.settings.set('agent.autonomyBudget', undefined)
        else ctx.settings.set('agent.autonomyBudget', n)
        return { ok: true, detail: n === 0 ? '已回缺省预算（8）' : `自治预算已改为 ${n}，立即生效` }
      },
    },
  )
}
