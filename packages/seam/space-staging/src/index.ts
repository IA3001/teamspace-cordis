// seam/space-staging —— 能力缝。
//
// 这一层只有词汇：Service 声明 + 数据形状 + 错误分类法。数据操作（IO）全部
// 抽象，由 impl/space-store-sqlite 实现。Plan 触发信号走 cordis 内核事件总线
// （'staging/plan'）—— 订阅方（P2 验收脚本 / P3 orchestrator）用 ctx.on 订阅，
// 接缝不变。曾试过在 Service 上放私有字段 + 订阅方法，实测被 cordis 的服务
// 代理重绑 this 后私有字段品牌校验炸掉（Cannot read private member，
// 2026-09-27 实测），内核事件总线才是 cordis 的惯用法。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧前端 StagingPanel.vue + 指令族 + 旧 store/doc.go 预留的
// staging_entries 表；P2 2026-09-27 补真，表由迁移 0004_staging_entries 建）：
//   Entry{ID, SessionID, AuthorID, Seq, Text, CreatedAt}
//   硬约束：**只有作者能改 / 撤自己的条目**（del/change 校验，违者 not_author）
//   硬约束：seq 会话内自增，删除后**不重排**（#2 删了，#3 还是 #3）
//   硬约束：非 / 消息自动入暂存区**不触发 Plan**；只有 /commit 触发，且恰好一次
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SessionEvent } from 'space-event'

declare module 'cordis' {
  interface Context {
    staging: StagingService
  }
  interface Events {
    /** /commit 成功后恰好一次。订阅：ctx.on('staging/plan', (p) => ...)。 */
    'staging/plan'(this: Context, payload: PlanPayload): void
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一条暂存发言。对应 staging_entries 表一行。 */
export interface Entry {
  /** 幂等键（uuid）。 */
  id: string
  sessionId: string
  authorId: string
  /** 会话内自增序号（从 1 起）；删除后不重排，新条目永远取 max(seq)+1。 */
  seq: number
  text: string
  /** ISO 8601（UTC）。 */
  createdAt: string
}

/** /commit 触发 Plan 时随信号带出的载荷。 */
export interface PlanPayload {
  sessionId: string
  /** 发起 /commit 的人。 */
  authorId: string
  /** 合并落库的那条人类发言事件（多条暂存按 seq 换行拼接成一条）。 */
  event: SessionEvent
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type StagingErrorCode =
  /** 目标条目不存在（已被删 / 序号从未用过）。 */
  | 'not_found'
  /** 改/撤别人的条目 —— 只有作者能操作自己的条目。 */
  | 'not_author'
  /** 条目文本为空（纯空白）。 */
  | 'empty_text'

export class StagingError extends Error {
  constructor(
    public readonly code: StagingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'StagingError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义（验收时逐条对拍）：
//   · append 分配 seq（max+1）并落库；纯空白 text → empty_text
//   · remove/update 先查条目：不存在 → not_found；authorId 不符 → not_author
//   · clear/count 只对会话，不校验作者（整区动作，承旧面板按钮语义）
//   · 时间戳一律 ISO 8601（UTC）
export abstract class StagingService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'staging')
  }

  /** 追加一条暂存发言，分配 seq，返回落定后的完整条目。 */
  abstract append(sessionId: string, authorId: string, text: string): Entry

  /** 某会话全部暂存条目，按 seq 升序。 */
  abstract list(sessionId: string): Entry[]

  /** 删除指定序号的条目。只有作者本人能删自己的条目。 */
  abstract remove(sessionId: string, seq: number, authorId: string): void

  /** 改写指定序号的条目。只有作者本人能改自己的条目。返回改后的条目。 */
  abstract update(sessionId: string, seq: number, authorId: string, text: string): Entry

  /** 某会话当前条目总数。 */
  abstract count(sessionId: string): number

  /** 清空某会话的暂存区，返回清掉的条数（/clear confirm 与 /commit 成功后用）。 */
  abstract clear(sessionId: string): number

  /**
   * /commit 的执行体：把暂存区全部条目按 seq 顺序用换行拼接成**一条**
   * 人类发言事件落库（authorKind=human / kind=message），随后清空暂存区，
   * 并发出恰好一次 Plan 信号。
   * 暂存区为空 → 返回 null：不落事件、不清空、**不触发 Plan**。
   * 把 commit 放进缝而不是让指令层自己拼：信号与「落库 + 清空」绑死在
   * 同一个实现里，"恰好一次"才是结构保证，不是口头约定。
   */
  abstract commit(sessionId: string, authorId: string): { event: SessionEvent; merged: number } | null
}
