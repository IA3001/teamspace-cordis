// seam/space-dialog —— 协作层（L8）对话/回合视图缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 回合视图是显示层/协作面板的**只读**口径：把一串原始事件折叠成「谁和谁、
// 一轮说了几句、怎么收的」的回合（turn）形状。流转层（orchestrator）未来
// 可提供实现；在它落地之前，本缝只立契约，不挡任何人的路。
//
// 词汇（承旧 elements/dialog/）：
//   结构化对话流的**只读**扩展点
//
// P0 阶段：只立 Service 声明，零业务。真能力在后续阶段。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    dialog: DialogService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个回合的只读视图（显示层/协作面板口径，不做任何解释性写回）。 */
export interface TurnView {
  sessionId: string
  /** 回合 id（实现自定义词表，同一会话内唯一）。 */
  turnId: string
  startedAt: string
  /** null = 回合尚未收束（还在进行中）。 */
  endedAt: string | null
  /** 参与者 principal id 列表（u_* / a_*）。 */
  participants: string[]
  messageCount: number
  /** 收束原因（如 'completed' / 'budget_exhausted' / 'interrupted'）。 */
  stopReason: string
}

/** 回合视图选项。 */
export interface TurnViewOptions {
  /** 返回上限（实现自定义缺省；取最新的 N 个回合）。 */
  limit?: number
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type DialogErrorCode = 'session_not_found'

export class DialogError extends Error {
  constructor(
    public readonly code: DialogErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DialogError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · turns 是纯读：会话不存在 → session_not_found；绝不产生写副作用。
//   · 回合按开始时间升序返回，limit 取最新的 N 个。
export abstract class DialogService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dialog')
  }

  /** 会话的回合视图（只读口径）。 */
  abstract turns(sessionId: string, opts?: TurnViewOptions): Promise<TurnView[]>
}
