// seam/space-orchestrator —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 domain/coordinator.go、domain/loop_detect.go，P3 2026-09-28 补真）：
//   委托决策（DecisionCase 四分支）、Delegation（单槽位：一轮至多一个目标）、
//   **暂停点 await_human**（回合状态机）、OrchestratorBrain（协调者大脑注入点）、
//   三级兜底的结果形状（parse 出的 CoordinatorDecision 原样承载）。
//
// 职责分家（MODULE-PLAN 第 4 节）：
//   本缝 = 「委托 / 暂停」的词汇与状态机
//   policy/space-authz = 「谁被授权、NLP 怎么判、兜底怎么写」
//
// 大脑为什么返回**原始文本**而不是结构化决策（P3 拍板：不含真实 LLM 适配器，
// 只留接口）：三级兜底（坏 JSON 正则救回 / 「将转达 X」补委托 / 负面语气护栏）
// 必须发生在真模型的输出上才有意义 —— 若大脑直接吐结构体，兜底就成了永远
// 不触发的死代码。原始文本进 policy 解析，门禁用桩大脑离线重放全部分支。
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { PlanPayload } from 'space-staging'
import type { SessionEvent } from 'space-event'

/** /commit 触发 Plan 的载荷 —— 本缝词汇的一部分，转出给实现与订阅方。 */
export type { PlanPayload } from 'space-staging'

declare module 'cordis' {
  interface Context {
    orchestrator: OrchestratorService
  }
  interface Events {
    /** 回合进入静止（暂停）时恰好一次。订阅：ctx.on('orchestrator/pause', (p) => ...)。 */
    'orchestrator/pause'(this: Context, payload: PausePayload): void
    /**
     * 引擎产出了合法委托，交通用 Agent 执行链去干活。
     * 订阅：ctx.on('orchestrator/delegate', (p) => ...) —— 执行方认领 target，干完调 ctx.orchestrator
     * 的收执口回报。引擎本身不执行（职责分家：决策归引擎、执行归执行链）。
     */
    'orchestrator/delegate'(this: Context, payload: DelegatePayload): void
  }
}

// ── 委托决策词汇（承旧 DecisionCase / Delegation / CoordinatorDecision）────

/** 一次 Plan 由哪个分支产出（承旧 DecisionCase）。 */
export type DecisionCase =
  /** 协调者理解了人类的明确授权，返回了一个合法目标委托。 */
  | 'delegated'
  /** 协调者仅与人类商议回复，没有委托目标。 */
  | 'replied'
  /** 委托目标不在可授权名单里（幻觉/越权），拒绝并暂停。 */
  | 'invalid_target'
  /** 协调者调用失败/返回空结果，暂停不猜。 */
  | 'coordinator_error'

/** 一次**经人类授权**的调用委托（承旧 Delegation）。 */
export interface Delegation {
  /**
   * 被授权的目标（授权名单里的一项）。词汇层放宽为 string：
   * 大脑可能幻觉出名单外的目标，**校验是引擎的职责**（拒绝 → invalid_target），
   * 不是类型的职责 —— 类型拦得住的错不叫幻觉。
   */
  target: string
  /** 给目标 agent 的具体任务。 */
  instruction: string
}

/** 协调者一次 Plan 的结构化结果（三级兜底解析的产物形状）。 */
export interface CoordinatorDecision {
  /** 给人类的对话回复（商议、确认、澄清）。 */
  reply: string
  /** 为什么委托 / 为什么不委托（给人看，也进日志）。 */
  reason: string
  /** null = 本轮只商议；非空 = 人类明确授权了某个目标。 */
  delegate: Delegation | null
}

/** 协调者规划所需的一切（承旧 PlanRequest）。全是值，零 IO。 */
export interface PlanRequest {
  sessionId: string
  /** 发起 /commit 的人。 */
  authorId: string
  /**
   * 人类这条发言的原话 —— 授权与否由大脑**读它（自然语言）判断**。
   * 这是「@ 指令走 NLP 判定而不是字符串识别」的落点：字符串只是提示。
   */
  humanText: string
  /**
   * @ 提及提示（会话内成员 id，承 events.mentions），**仅供参考**：
   * 它不是路由依据 ——「让记录官整理一下」没有 @ 也应被识别；
   * @ 与自然语言冲突时以自然语言为准（承旧 MentionHints 口径）。
   */
  mentionHints: string[]
  /**
   * 本会话当前可被授权的目标名单：会议目标角色与已加入会话的 Agent title。
   * 使用 string，授权校验归引擎（isAuthorizedTarget），类型不拦。
   */
  targets: readonly string[]
}

// ── 回合状态机（承旧 Turn / State / Pause）────────────────────────────────

/** 回合状态：chain = 流程进行中；static = 静止（常态）。 */
export type TurnState = 'chain' | 'static'

/** 暂停原因（stopReason 的约定取值；界面与日志都按它显示）。 */
export type StopReason =
  /** 已暂停，等待人类下一步指示（保留；IM 化后仅在预算耗尽与错误停机时出现，不再是默认路径）。 */
  | 'await_human'
  /** Agent 明确标记需要 DRI 决定；依赖工作暂停，等待固定决策命令。 */
  | 'await_human_decision'
  /** 回合自然完成：无未完成委托且协调者不再继续（IM 化后的默认收敛路径，2026-09-30）。 */
  | 'completed'
  /** 每回合自治预算耗尽，暂停等人类（IM 化改造，2026-09-30）。 */
  | 'budget_exhausted'
  /** 委托了名单外目标，已拒绝并暂停。 */
  | 'invalid_target'
  /** 协调者大脑未注册。 */
  | 'coordinator_unconfigured'
  /** 协调者调用失败（不猜、不重试）。 */
  | 'coordinator_error'
  /** 协调者返回空输出（不委托不报错只暂停）。 */
  | 'coordinator_empty'
  /** 同一轮内对同一目标的重复委托被拒。 */
  | 'duplicate_target'
  /** 共享 Agent 目录里找不到被委托的目标（引擎-目录不同步，编程错误）。 */
  | 'agent_target_unknown'

/** 一个回合的状态快照（承旧 Turn，只保留人类授权制下仍在用的字段）。 */
export interface Turn {
  state: TurnState
  /** 本回合协调者大脑**实际发起**的调用次数（资源口径：每条人类消息恰好 1 次）。 */
  decisionCalls: number
  /**
   * 本回合已消耗的自治动作数（IM 化改造，2026-09-30）：每次引擎发起委托 /
   * 继续调用 +1，达到每回合预算（默认 8）→ budget_exhausted 暂停。
   */
  autonomousActions: number
  /** 本回合已委托过的目标（一轮内同一目标只能调一次的可观测账本）。 */
  delegatedTargets: string[]
  /** 本次为什么停（空 = 没停）。要在界面上能看见，不是只进日志。 */
  stopReason: string
  /** 一句话说明，给人看。 */
  stopDetail: string
}

/** 'orchestrator/pause' 的载荷：谁停的、为什么停。stopReason 与 Turn 对齐为
 *  string（Turn 的空串语义 = 没停；具体取值约定见 StopReason）。 */
export interface PausePayload {
  sessionId: string
  stopReason: string
  stopDetail: string
}

/**
 * 'orchestrator/delegate' 的载荷（P6 收尾）：引擎产出的合法委托。
 * target 是授权名单里的一项 —— 会议机器人 = 角色（如「会议记录官」），
 * Agent target = 共享目录 title 或 id（承 /tell 的双口径解析口径）。
 */
export interface DelegatePayload {
  sessionId: string
  /** 触发本轮 Plan 的人类事件 id（追溯用）。 */
  eventId: string
  target: string
  instruction: string
}

/** 一次 Plan 的可断言产物（承旧 StepResult）。 */
export interface StepResult {
  case: DecisionCase
  /** 协调者给人类的回复。 */
  reply: string
  /** case = 'delegated' 时非空。 */
  delegation: Delegation | null
  /** 分支理由。 */
  reason: string
}

// ── 大脑接口（协调者 = 能力层注入；门禁用桩替换，离线重放）───────────────

/**
 * 协调者大脑。真实实现内部调一次 LLM（NLP 判定授权与否）；领域与门禁
 * 只依赖这个接口 —— 桩替换后**无网、无模型、无数据库**也能重放整个状态机
 * （铁律 2 的原始动机，承旧 Coordinator interface）。
 *
 * 返回**原始输出文本**：可能是合法 JSON、坏 JSON 或纯文本 —— 三级兜底
 * 在 policy/space-authz 里对它解析。抛错 = 调用失败（引擎按 coordinator_error
 * 暂停，不猜、不重试）。
 */
export interface OrchestratorBrain {
  plan(req: PlanRequest): Promise<string>
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type OrchestratorErrorCode =
  /** 大脑重复注册（唯一，重复是编程错误）。 */
  | 'duplicate_brain'
  /** 目标 agent 在不存在的委托上反馈（回合不在 chain / 目标不符）。 */
  | 'not_delegating'

export class OrchestratorError extends Error {
  constructor(
    public readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义（承旧 Engine，验收时逐条对拍）：
//   · onPlan：每回合恰好一次大脑调用（decisionCalls=1）；无脑/失败/空输出/
//     名单外目标一律**暂停**（state=static）且不猜；合法委托 → 输出
//     「已收到指令，将委托[target]：…」后保持 chain 等目标反馈。
//   · reportFeedback / reportAgentResult：反馈视为结果回流（IM 化改造
//     2026-09-30），由引擎按每回合自治预算决定继续；无新委托且协调者不再
//     继续 → completed 收敛，预算耗尽 → budget_exhausted 暂停。
//   · 回合状态热缓存于进程内存，并由实现层持久化；恢复必须以 SQLite 状态与
//     事件来源校验，避免重复回复、重复委托或跳过未完成步骤。
export abstract class OrchestratorService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'orchestrator')
  }

  /** 注册协调者大脑（全局唯一；重复注册是编程错误 → duplicate_brain）。 */
  abstract registerBrain(brain: OrchestratorBrain): void

  /**
   * Plan 触发入口：订阅方把 'staging/plan' 原样转交进来（P2 留的接缝，
   * 接缝不变）。空回合重开（承旧 BeginHumanTurn：人类发言抢占）。
   * 返回 StepResult；被并发 Plan 挤掉的调用返回 null。
   */
  abstract onPlan(payload: PlanPayload): Promise<StepResult | null>

  /**
   * 目标 agent 反馈入口：落一条该 agent 的发言事件（IM 化改造 2026-09-30：
   * 反馈视为结果回流，由引擎按自治预算决定是否继续 —— 不再强制暂停；
   * 收敛语义见 StopReason.completed / budget_exhausted）。
   * 没有在途委托时调用 → not_delegating。
   */
  abstract reportFeedback(sessionId: string, target: string, text: string, sourceEventIds?: string[]): SessionEvent

  /** Store a result from any invited, data-defined or built-in Agent. */
  abstract reportAgentResult(sessionId: string, target: string, text: string, sourceEventIds?: string[]): SessionEvent

  /** Forget an in-flight delegate after its source is invalidated. */
  abstract cancelDelegatedTask(sessionId: string, target: string, sourceEventId: string): boolean

  /** Synchronously clear all in-flight delegate ledger entries for a withdrawn source. */
  abstract cancelDelegationsBySource(sessionId: string, sourceEventId: string): string[]

  /** Stop launching dependent work while affected Agents review a pending DRI decision. */
  abstract pauseForDecisionReview(sessionId: string, detail: string): void

  /** Release the review hold after the DRI has recorded a final decision. */
  abstract resolveDecisionReview(sessionId: string): void

  /**
   * 外部委托入口（IM 化流程轨，2026-10-01）：MC 式服务流程（flow-commands）
   * 的派发不走大脑 decide，但收执口要求在途账本 —— 由本方法把外部委托先
   * 登记进引擎账本（无回合则开新回合）再发出 'orchestrator/delegate'。
   * 没有它，agent 回报会因 not_delegating 无处可交。
   */
  abstract beginExternalDelegate(
    sessionId: string,
    eventId: string,
    target: string,
    instruction: string,
  ): void

  /** 回合状态快照（无记录的会话返回默认静止回合）。 */
  abstract turn(sessionId: string): Turn
}
