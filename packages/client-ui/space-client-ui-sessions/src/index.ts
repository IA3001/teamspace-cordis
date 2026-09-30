// space-client-ui-sessions —— 左侧会话栏（2026-09-29 团队空间改版，纯新增包）。
//
// 入驻形态（铁律 4 精神「入驻 = 纯新增」）：本包不注册页面（不新增菜单项），
// client 侧经外壳原生通道 ctx.client.router.slot({ type, component }) 把
// 会话栏组件挂到 'space-teamspace-sidebar' 槽位；整页（space-client-ui-
// teamspace）在左区渲染 <k-slot name="space-teamspace-sidebar" single>——
// 页面只认槽位名，不 import 本包；本包停用 = 槽位无视图 = 页面左区自然收空，
// 既有文件零改动。Panel 描述符照旧登记进 ctx.ui（台账可查，GET /api/panels）。
//
// 数据经本 entry 的 data（RPC）直取服务，不开 HTTP 口；服务端 space-api
// 只读口保持不变。
// 建会流程（P8，2026-09-30，补 P7 遗留 1）：create 不再只带 DRI —— 服务端
// 一次入齐默认名册（当前身份 DRI + 协调者 + 会议三机器人），再按多选结果把
// coding 角色以本 id 入会（= Member，duty 用名册 title 作展示名）。授权链
// 不依赖本多选 —— coding 授权走名册制（P6 收尾已通）；入会解决的是
// 可见性（成员表/@ 联想）与 @ 提示的落库（handleInbound 按 memberIds 匹配）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'

export const name = 'space-client-ui-sessions'
// cordis 严格注入（P4 教训：RPC 数据函数里摸到的每个服务都要进 inject）：
// agents 是 P8 新增 —— coding 名册（多选数据源 + 入会解析）。
export const inject = ['webui', 'ui', 'session', 'agents']

/**
 * 建会入册（P8，补 P7 遗留 1）：建会（open）→ 当前身份（u_dri）以 DRI 入册 →
 * 默认名册（协调者 + 会议三机器人，与 seed/0001 口径一致）→ selectedIds 里的
 * coding 角色以本 id 入会（role='成员'，duty=名册 title；名册外 id 忽略，不炸）。
 * 独立导出：verify-p8 进程内直调（不经过 webui RPC），与运行时同一条代码路径。
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
  const roster = new Map(ctx.agents.list('coding').map((a) => [a.descriptor.id, a.descriptor]))
  for (const id of selectedIds) {
    const d = roster.get(id)
    if (d) ctx.session.join({ sessionId: sid, principalId: d.id, role: '成员', duty: d.title })
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
      async sessions() {
        return ctx.session.listSessions()
      },
      async members(sessionId: string) {
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      /** coding 名册（P8）：新会议「附加角色」多选的数据源（title 展示，id 入会）。 */
      async codingRoster() {
        return ctx.agents.list('coding').map((a) => ({
          id: a.descriptor.id,
          title: a.descriptor.title,
          promptRef: a.descriptor.promptRef ?? null,
        }))
      },
      async create(selectedIds: string[] = []) {
        return createSessionWithRoster(ctx, selectedIds)
      },
    },
  )
}
