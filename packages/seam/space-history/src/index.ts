// seam/space-history —— 会话层（L5）事件视图过滤器缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 impl/space-store-sqlite（events 表）或 eventLog 组合提供（ctx.history）。
// 上层（上下文注入层、协作面板）只问本缝要过滤后的事件视图，不摸 events 表细节 ——
// 过滤是纯读语义：绝不产生写副作用，绝不改动事件本身（事件只追加、永不改）。
//
// 词汇（承旧 elements/history/）：
//   事件视图过滤器
//
// P0 阶段：只立 Service 声明，零业务。真能力在后续阶段。
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SessionEvent } from 'space-event'

declare module 'cordis' {
  interface Context {
    history: HistoryService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 视图过滤选项。全部缺省 = 不过滤（返回全部）。 */
export interface HistoryViewOptions {
  /** 按作者种类过滤：'human' | 'agent' | 'system'。 */
  authorKind?: 'human' | 'agent' | 'system'
  /** 按事件种类过滤（kind 词表归 space-event）。 */
  kind?: string
  /** 起始时间（含），ts 词法比较。 */
  sinceTs?: string
  /** 截止时间（含），ts 词法比较。 */
  untilTs?: string
  /** 返回上限（实现自定义缺省；按 seq 降序取最新的）。 */
  limit?: number
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type HistoryErrorCode = 'bad_range' | 'session_not_found'

export class HistoryError extends Error {
  constructor(
    public readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HistoryError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · view 是纯过滤：会话不存在 → session_not_found；sinceTs > untilTs
//     → bad_range（其余非法参数同理）。
//   · 结果按 seq 升序返回（时间线口径），limit 取最新的 N 条。
//   · 过滤语义的实现在 store 或由 eventLog 组合，本缝只定形状。
export abstract class HistoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'history')
  }

  /** 会话事件的过滤视图（纯读）。 */
  abstract view(sessionId: string, opts?: HistoryViewOptions): SessionEvent[]
}
