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
// 只读口保持不变。新会议 = createSession + 当前身份（u_dri）以 DRI 入册 ——
// 完整会议名册（3 目标 agent + 协调者）属 kickoff 域，待其落地后接入。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'

export const name = 'space-client-ui-sessions'
export const inject = ['webui', 'ui', 'session']

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
      /** 新会议：建会（open）+ 当前身份以 DRI 入册，返回新会话（前端随即选中它）。 */
      async create() {
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const title = `新会议 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
        const session = ctx.session.createSession({ title })
        ctx.session.join({ sessionId: session.id, principalId: 'u_dri', role: 'DRI' })
        return session
      },
    },
  )
}
