// seam/space-message —— 能力缝（IM 化改造 2026-09-30 补真）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 plugins/space-message（ctx.messages.send）；任何参与者（含 AI 成员）
// 的发言都走这一条缝 —— 落 eventLog + emit 'space/event-appended' 绑死在同一
// 方法里，"恰好一次"是结构保证。AI 的"主动发言"= agent 插件直接调 send，
// 与人类消息同一条落库+广播路径，没有第二条暗道。
//
// 词汇（承旧 elements/message/ 的入站管线顺序约定 + 本次新增）：
//   send → 校验（在册成员/非空）→ eventLog.append → emit 'space/event-appended'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SessionEvent } from 'space-event'

declare module 'cordis' {
  interface Context {
    messages: MessageService
  }
  interface Events {
    /** 任何事件落库后恰好一次（人类消息 / agent 消息 / 系统事件同源）。 */
    'space/event-appended'(this: Context, payload: { event: SessionEvent }): void
    /**
     * 人类消息直达时间线后发出（IM 化后的 AI 触发源，替代「暂存→/commit」
     * 的 staging/plan 成为默认路径；staging/plan 仍随 /commit 发出，双轨兼容）。
     */
    'space/plan'(this: Context, payload: PlanSignal): void
  }
}

/** 'space/plan' 载荷：谁在哪个会话说了什么。 */
export interface PlanSignal {
  sessionId: string
  authorId: string
  /** 服务端按在册成员解析出的 @ 目标（空数组 = 纯聊天，不打扰 AI）。 */
  mentions: string[]
  event: SessionEvent
}

/** 自治回合的收敛语义（orchestrator 的 StopReason 同步扩充）。 */
export type AutonomyStopReason =
  /** 无未完成委托且协调者不再继续 —— 回合自然完成。 */
  | 'completed'
  /** 空闲（无回合）。 */
  | 'idle'
  /** 每回合自治预算耗尽，暂停等人类。 */
  | 'budget_exhausted'

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type MessageErrorCode = 'session_not_found' | 'empty_text' | 'unknown_author' | 'not_member'

export class MessageError extends Error {
  constructor(
    public readonly code: MessageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MessageError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · send：作者必须是该会话在册成员（违者 not_member）；文本拒空白（empty_text）；
//     authorKind 由作者 id 前缀推断（u_* → human，a_* → agent，其余 unknown_author）。
//   · mentions：服务端按在册成员解析 @token，与调用方显式 mentions 取并集。
//   · 落库 + emit 'space/event-appended' 绑死在同一方法。
export abstract class MessageService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'messages')
  }

  /** 发一条消息上时间线（人类与 AI 成员同一入口）。返回落定的完整事件。 */
  abstract send(
    sessionId: string,
    authorId: string,
    text: string,
    mentions?: string[],
    replyTo?: string | null,
  ): Promise<SessionEvent>
}
