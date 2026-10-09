// space-history —— 事件视图过滤器的实现（分层架构 L5 会话层，2026-10-01）。
//
// ctx.history.view = eventLog.listBySession 的纯过滤视图（作者种类 / 事件种类 /
// 时间窗 / 条数），供显示层（时间线分组）与协作面板按口径取数。
// 组合式实现：数据唯一来源是 ctx.eventLog（会话层内组合，不碰 SQL）——
// 语义契约见 seam/space-history。
import type { Context } from 'cordis'
import { HistoryService } from 'space-history'
import type { HistoryViewOptions } from 'space-history'
import type { SessionEvent } from 'space-event'

export const name = 'space-history'
export const inject = ['eventLog', 'session']

class HistoryViewService extends HistoryService {
  constructor(ctx: ConstructorParameters<typeof HistoryService>[0]) {
    super(ctx)
  }

  view(sessionId: string, opts: HistoryViewOptions = {}): SessionEvent[] {
    if (!this.ctx.session.getSession(sessionId)) {
      // 纯读面：未知会话返回空视图（不抛 —— 显示层拿空态渲染更顺）。
      return []
    }
    const list = this.ctx.eventLog.listBySession(sessionId)
    const filtered = list.filter((e) => {
      if (opts.authorKind && e.authorKind !== opts.authorKind) return false
      if (opts.kind && e.kind !== opts.kind) return false
      if (opts.sinceTs && e.ts < opts.sinceTs) return false
      if (opts.untilTs && e.ts > opts.untilTs) return false
      return true
    })
    return opts.limit ? filtered.slice(-opts.limit) : filtered
  }
}

export function apply(ctx: Context) {
  new HistoryViewService(ctx)
  console.log(`[${name}] 就绪：ctx.history.view（eventLog 纯过滤视图）`)
}
