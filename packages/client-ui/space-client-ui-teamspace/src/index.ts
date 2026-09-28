// space-client-ui-teamspace —— 团队空间整页（P4，2026-09-28 按用户反馈定稿）。
//
// 一页整体，不做四个散页（用户拍板「太零散」）：中间时间线、右列轮次状态 +
// 成员、下方输入区。数据全部经本 entry 的 data（RPC）直取服务，不开 HTTP 口。
// Panel 描述符照旧登记进 ctx.ui（P5 组合面按 slot 拼装的可查询台账）。
//
// 发送走 handleInbound（plugins/staging-commands 导出的语义处理体）—— 与
// POST /api/sessions/:id/messages 同一条代码路径，语义只有一份。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import { handleInbound } from '../../../../plugins/staging-commands/index.ts'

export const name = 'space-client-ui-teamspace'
export const inject = ['webui', 'ui', 'session', 'eventLog', 'staging', 'commands', 'orchestrator']

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
      async sessions() {
        return ctx.session.listSessions()
      },
      async commands() {
        return ctx.commands.list().map((c) => ({ name: c.name, usage: c.usage, minArgs: c.minArgs, maxArgs: c.maxArgs }))
      },
      async events(sessionId: string) {
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.eventLog.listBySession(sessionId)
      },
      async members(sessionId: string) {
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.session.listMembers(sessionId, true)
      },
      async staging(sessionId: string) {
        if (!ctx.session.getSession(sessionId)) return null
        return ctx.staging.list(sessionId)
      },
      async turn(sessionId: string) {
        return ctx.orchestrator.turn(sessionId)
      },
      async send(sessionId: string, authorId: string, text: string, mentions: string[] = []) {
        return handleInbound(ctx, sessionId, authorId, text, mentions)
      },
    },
  )
}
