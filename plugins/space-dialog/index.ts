// space-dialog —— 回合视图实现（L8 协作层，2026-10-01）。
//
// ctx.dialog.turns = 把事件流折叠成回合视图的只读口径。折叠规则（纯推导，
// 零自有状态、重启无损）：
//   · 一条人类 message 事件 = 一个新回合的开始；
//   · 回合吞掉其后所有非人类 message 事件（agent 发言 / 系统事件），
//     直到下一条人类 message；
//   · 回合收束原因取「回合内最后一条系统事件」的 text（orchestrator 的
//     暂停/完成都会落系统事件），没有则以回合作废口径 'open' 收尾。
// 语义契约见 seam/space-dialog（纯读、升序、limit 取最新 N 个）。
import type { Context } from 'cordis'
import { DialogService } from 'space-dialog'
import type { TurnView, TurnViewOptions } from 'space-dialog'

export const name = 'space-dialog'
export const inject = ['session', 'eventLog']

class DialogViewService extends DialogService {
  constructor(ctx: ConstructorParameters<typeof DialogService>[0]) {
    super(ctx)
  }

  async turns(sessionId: string, opts: TurnViewOptions = {}): Promise<TurnView[]> {
    if (!this.ctx.session.getSession(sessionId)) {
      throw new (await import('space-dialog')).DialogError(
        'session_not_found',
        `会话 ${sessionId} 不存在`,
      )
    }
    const events = this.ctx.eventLog.listBySession(sessionId)
    const turns: TurnView[] = []
    let cur: TurnView | null = null
    for (const e of events) {
      if (e.voided) continue
      if (e.authorKind === 'human' && e.kind === 'message') {
        // 新回合开始（上一回合被动收束为 open —— 由收束系统事件兜底的除外）。
        if (cur && !cur.endedAt) cur.endedAt = e.ts
        cur = {
          sessionId,
          turnId: `t_${e.seq}`,
          startedAt: e.ts,
          endedAt: null,
          participants: e.authorId ? [e.authorId] : [],
          messageCount: 1,
          stopReason: 'open',
        }
        turns.push(cur)
        continue
      }
      if (!cur) continue // 首条人类消息之前的系统/agent 事件不归属任何回合
      cur.messageCount++
      if (e.authorId && !cur.participants.includes(e.authorId)) cur.participants.push(e.authorId)
      if (e.authorKind === 'system' && e.text) {
        // 流转层的暂停/完成都落系统事件：取其 text 作为收束口径。
        cur.stopReason = e.text.slice(0, 60)
        cur.endedAt = e.ts
      }
    }
    // limit 取最新的 N 个（升序语义不变：从尾部截取后仍按开始时间升序返回）。
    return opts.limit ? turns.slice(-opts.limit) : turns
  }
}

export function apply(ctx: Context) {
  new DialogViewService(ctx)
  console.log(`[${name}] 就绪：ctx.dialog.turns（事件流折叠的只读回合视图）`)
}
