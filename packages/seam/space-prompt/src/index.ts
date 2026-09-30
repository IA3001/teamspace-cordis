// seam/space-prompt —— 能力缝（P8 机制层，2026-09-30）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/（sqlite 后端挂 space-store-sqlite，与 staging 同款先例）。
//
// 为什么独立成缝（不并入 space-agent）—— 防杂物袋判据（待定 8 先例）：
//   · space-agent 管的是「名单与生命周期」（谁入驻、什么状态），零存储语义；
//   · 提示词是**内容资产**：可独立 CRUD（upsert 换文案不动名单）、可被非 agent
//     消费者引用（未来的 kickoff 模板、评估器都可能是提示词客户）；
//   · 混入会让 agent 缝背上存储词汇 —— 两类消费者、两种变更节奏，缝就废了。
// 待定 10 的接入形态由此落定：AgentDescriptor.promptRef 是**引用**（稳定标识），
// 内容本体住本缝 —— 引用与内容分离，换文案零改名单。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    prompts: PromptService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一条提示词模板。ref 是稳定标识（如 'prompt.minutes'），upsert 的幂等键。 */
export interface PromptTemplate {
  /** 稳定标识（AgentDescriptor.promptRef 指向它）。 */
  ref: string
  /** 给人看的名字（如「会议记录官提示词」）。 */
  title: string
  /** 正文（当前为 P8 占位文案，明示「待原文」—— 等 4 角色原文落地后 upsert 替换）。 */
  body: string
  updatedAt: string
}

// ── 错误分类法（规律 3：实现不得自造错误串，只能抛这里的错误码）────────────

export type PromptErrorCode =
  | 'not_found'
  | /** ref/title/body 为空或空白（提示词三要素缺一不可）。 */ 'invalid_input'

export class PromptError extends Error {
  constructor(
    public readonly code: PromptErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PromptError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · get：未知 ref → not_found
//   · upsert：幂等 —— 新 ref 插入，已有 ref 整体替换（title/body/updatedAt）；
//     ref/title/body 任一空白 → invalid_input
//   · list：按 ref 稳定排序
export abstract class PromptService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'prompts')
  }

  abstract get(ref: string): PromptTemplate

  abstract upsert(ref: string, title: string, body: string): PromptTemplate

  abstract list(): PromptTemplate[]
}
