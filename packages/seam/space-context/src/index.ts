// seam/space-context —— 上下文注入层能力缝（2026-09-30 分层架构新增）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 plugins/space-context 提供（ctx.context）：为一次 Agent/大脑调用
// 组装完整上下文 —— 系统提示词（prompt 模板）+ 最近历史（eventLog）+
// 记忆召回（memory）+ 检索命中（retrieval），并做统一的字符预算裁剪。
// Agent 层 / 流转层调 LLM 前一律通过本缝取上下文，**不得**各自手拼 prompt ——
// 这是「注入逻辑只有一份」的结构保证（与 handleInbound 同款惯例）。
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { MemoryItem } from 'space-memory'
import type { RetrievalHit } from 'space-retrieval'
import type { SessionEvent } from 'space-event'

declare module 'cordis' {
  interface Context {
    context: ContextAssemblyService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 组装产物：一次调用的全部注入面。 */
export interface AssembledContext {
  sessionId: string
  /** 系统提示词（promptRef 模板 + 角色说明 + 工具目录），已裁剪到预算内。 */
  system: string
  /** 最近历史（按 seq 升序，最多 recentLimit 条）。 */
  history: SessionEvent[]
  /** 记忆召回（weight×新近度排序后截断）。 */
  memories: MemoryItem[]
  /** 检索命中（score 降序，query 非空时才有）。 */
  retrieval: RetrievalHit[]
  /** 实际使用的字符预算（system+history 序列化后的近似值，可观测）。 */
  approxChars: number
}

/** 组装选项。 */
export interface AssembleOptions {
  /** 系统提示词模板引用（缺省 'prompt.minutes'）。 */
  promptRef?: string
  /** 最近历史条数（缺省 20）。 */
  recentLimit?: number
  /** 记忆召回条数（缺省 5；0 = 不注入记忆）。 */
  memoryLimit?: number
  /** 检索 query（非空才做检索注入）。 */
  query?: string
  /** 字符预算（缺省 12000；超限从最旧的历史开始裁）。 */
  charBudget?: number
  /** 调用者（写进系统提示词的「你是谁」段；缺省不写）。 */
  persona?: string
}

// ── 错误分类法 ───────────────────────────────────────────────────────────
export type ContextErrorCode = 'session_not_found' | 'prompt_missing'

export class ContextError extends Error {
  constructor(
    public readonly code: ContextErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContextError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · 会话不存在 → session_not_found；promptRef 模板缺失 → prompt_missing。
//   · history 按 seq 升序；memories 按实现层口径排序；全部字段就绪才算组装成功。
//   · charBudget 裁剪顺序：先保 system，再保 memories/retrieval 摘要，最后裁 history。
//   · 组装是纯读 —— 绝不产生写副作用。
export abstract class ContextAssemblyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'context')
  }

  /** 为某会话的一次调用组装上下文。 */
  abstract assemble(sessionId: string, opts?: AssembleOptions): Promise<AssembledContext>
}
