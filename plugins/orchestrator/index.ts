// orchestrator —— ctx.orchestrator 服务实例的提供者 + Plan 触发的接管者（P3）。
//
// 职责（MODULE-PLAN 第 4 节职责分家的引擎侧）：
//   · 回合状态机：每回合恰一次（或多次自治续步）大脑调用、委托单槽位去重、
//     自治预算（IM 化改造，2026-09-30）。
//   · IM 化改造（2026-09-30，用户拍板）：废止「收到 agent 反馈必须
//     await_human」为默认行为 —— 反馈是**结果回流**，引擎按每回合自治预算
//     决定是否继续；无新委托且协调者不再继续 → 'completed' 自然收敛；
//     预算耗尽 → 'budget_exhausted' 暂停等人类。await_human 保留但仅在
//     错误停机（invalid_target / duplicate_target / coordinator_* 等）时出现。
//   · 触发源（双轨）：'staging/plan'（/commit 兼容路径）+ 'space/plan'
//     （IM 主路径：@ 了任何 a_* 成员或会议目标角色才触发，纯聊天不打扰 AI）
//     + 'space/event-appended'（agent 事件回流 → 引擎决定继续）。
//   · 名单校验与三级兜底调 policy/space-authz 的纯函数；本插件不自己
//     写授权判定（职责分家：策略归 policy）。
//
// 状态存进程内存（P3 拍板）：Map<sessionId, Turn>，重启回到 static ——
// 静止即安全默认，不建表不加迁移；暂停原因同时 emit 'orchestrator/pause'
// 并落 ctx.logger（warn/详情），5172 日志页可见（铁律 2）。
//
// 类用 TS private 字段（编译期私有）—— 不用 # 私有字段：cordis 服务代理
// 重绑 this 后 # 品牌校验必炸（2026-09-27 实测，见 seam/space-staging 头注）。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { SessionEvent } from 'space-event'
import { OrchestratorError, OrchestratorService } from 'space-orchestrator'
import type {
  DelegatePayload,
  OrchestratorBrain,
  PausePayload,
  PlanPayload,
  StepResult,
  Turn,
} from 'space-orchestrator'
import type { PlanSignal } from 'space-message'
import { authorizedTargets, isAuthorizedTarget, parseCoordinatorOutput } from 'space-authz'

export const name = 'orchestrator'
// cordis 严格注入检查：apply 里摸到的每个服务都要声明（漏了会得到
// "cannot get property without inject"，且只进 5172 日志页，不上控制台）。
// agents（P6 收尾）：coding 名册 —— 授权名单 = 会议角色 + 在册 coding agent；
// workdir/命令路径不经本插件（coder 自己用），不注入。
export const inject = ['server', 'session', 'eventLog', 'agents', 'settings']

/**
 * 插件配置面板 schema（5172 自动渲染，IM 化改造 2026-09-30）。
 */
export const Config = z.object({
  autonomyBudget: z.number().min(1).max(50)
    .description('每回合 AI 自主动作预算（引擎发起委托/继续调用的次数上限，超限暂停等人类）')
    .default(8),
})

/** 运行时取值形状（兼容旧取值：全部可选，缺省回 DEFAULT_BUDGET）。 */
export interface Config {
  /** 每回合自治预算（引擎发起委托/继续调用的次数上限）。缺省 8。 */
  autonomyBudget?: number
}

const DEFAULT_BUDGET = 8

const now = () => new Date().toISOString()

const staticTurn = (): Turn => ({
  state: 'static',
  decisionCalls: 0,
  autonomousActions: 0,
  delegatedTargets: [],
  stopReason: '',
  stopDetail: '',
})

export class OrchestratorEngine extends OrchestratorService {
  private readonly turns = new Map<string, Turn>()
  private readonly inFlight = new Set<string>()
  /** 续步串行化：同一会话的回流续步一次只有一个（防回流风暴）。 */
  private readonly continuing = new Set<string>()
  private brain: OrchestratorBrain | null = null
  private readonly budget: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.budget = config.autonomyBudget ?? DEFAULT_BUDGET
  }

  /** 现算预算：5172 /agents 页写入的 agent.autonomyBudget 优先（改完即生效），
   *  未设置时回退启动 Config（其缺省 DEFAULT_BUDGET）。 */
  private currentBudget(): number {
    const v = this.ctx.settings?.get<number>('agent.autonomyBudget', 0)
    return v && v > 0 ? v : this.budget
  }

  registerBrain(brain: OrchestratorBrain): void {
    if (this.brain) {
      throw new OrchestratorError('duplicate_brain', '协调者大脑已注册（全局唯一，重复注册是编程错误）')
    }
    this.brain = brain
  }

  turn(sessionId: string): Turn {
    return { ...this.turns.get(sessionId) ?? staticTurn() }
  }

  private snapshot(sessionId: string): Turn {
    let t = this.turns.get(sessionId)
    if (!t) {
      t = staticTurn()
      this.turns.set(sessionId, t)
    }
    return t
  }

  /** 无条件进入静止 + 广播 + 留日志（承旧 Engine.Pause：异常分支结尾必须调用）。 */
  private pause(sessionId: string, stopReason: string, stopDetail: string): void {
    const t = this.snapshot(sessionId)
    t.state = 'static'
    t.stopReason = stopReason
    t.stopDetail = stopDetail
    const payload: PausePayload = { sessionId, stopReason, stopDetail }
    this.ctx.emit('orchestrator/pause', payload)
    this.ctx.logger.warn('[orchestrator] 暂停（%s）：%s', stopReason, stopDetail)
  }

  async onPlan(payload: PlanPayload): Promise<StepResult | null> {
    const { sessionId, authorId, event } = payload
    // 一次只有一个人在说话（承旧 Engine 串行化口径）：在途大脑调用期间
    // 新 Plan 直接忽略 —— 人类重发 /commit 是下一回合的事。
    if (this.inFlight.has(sessionId) || this.continuing.has(sessionId)) {
      this.ctx.logger.warn('[orchestrator] 上一轮 Plan 仍在进行，忽略本次触发（会话 %s）', sessionId)
      return null
    }
    // 单套 Agent 全局禁令（2026-10-01，用户拍板）：一台服务器一套 Agent，
    // AI（大脑 + 全部 Agent）同一时刻只服务一个会话。其它会话的召唤不是
    // 静默丢弃，而是落一条系统事件当场告知原因（铁律 2：拒绝也要可见）。
    const holder = [...this.turns.entries()].find(([sid, t]) => t.state === 'chain' && sid !== sessionId)
    let busyAgent: string | null = null
    try {
      busyAgent = this.ctx.agents.list('coding').find((a) => a.status === 'working')?.descriptor.title ?? null
    } catch {
      busyAgent = null // agents 服务不可用时不过这道闸（buildTargets 已有降级口径）
    }
    if (holder || busyAgent) {
      const why = holder ? `AI 正在服务会话 ${holder[0]}` : `Agent「${busyAgent}」正忙于其它会话任务`
      this.ctx.logger.warn('[orchestrator] 跨会话召唤被拒（%s）：请求方 %s', why, sessionId)
      try {
        this.ctx.eventLog.append({
          id: randomUUID(),
          sessionId,
          authorId: null,
          phaseId: null,
          authorKind: 'system',
          kind: 'system',
          text: `⚙ ${why}（单套 Agent，同一时刻只服务一个会话）。请稍后再 @`,
          mentions: [],
          toolCalls: [],
          replyMode: '',
        })
      } catch {
        // 留痕失败不影响拒绝本身（拒了就是拒了，日志已有）。
      }
      return null
    }
    this.inFlight.add(sessionId)
    try {
      return await this.planOnce(payload)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  /** 授权名单 = 会议三机器人角色（policy 纯函数）+ 在册 coding agent 名册。 */
  private buildTargets(sessionId: string): string[] {
    const meetingTargets = authorizedTargets(this.ctx.session.listMembers(sessionId, true))
    let codingTargets: string[] = []
    try {
      codingTargets = this.ctx.agents.list('coding').map((a) => a.descriptor.title)
    } catch {
      this.ctx.logger.warn('[orchestrator] agents 服务不可用，授权名单仅含会议角色（无 coding 名册）')
    }
    // 自定义会议 Agent（/agents 页创建，settings 持久化）：title 直接进
    // 授权名单 —— @标题 即可派单（2026-10-07）。
    let customTargets: string[] = []
    try {
      customTargets = this.ctx.settings.get<Array<{ title: string }>>('agent.custom', []).map((a) => a.title)
    } catch { /* settings 不可用则忽略 */ }
    return [...meetingTargets, ...codingTargets, ...customTargets]
  }

  private async planOnce({ sessionId, authorId, event }: PlanPayload): Promise<StepResult | null> {
    // 人类发言抢占：开新回合，旧停止原因清掉（承旧 BeginHumanTurn）。
    // 新回合自治预算清零（delegatedTargets 去重账本同样自动清空）。
    this.turns.set(sessionId, {
      state: 'chain',
      decisionCalls: 0,
      autonomousActions: 0,
      delegatedTargets: [],
      stopReason: '',
      stopDetail: '',
    })
    return this.decide(sessionId, authorId, event.text, event.mentions, event.id)
  }

  /**
   * 一次协调者决策（IM 化改造后成为自治续步的复用点）：人类触发与 agent
   * 回流续步共用。每此调用消耗 1 个自治动作（先记账再调大脑，超限即停）。
   */
  private async decide(
    sessionId: string,
    authorId: string,
    humanText: string,
    mentionHints: string[],
    eventId: string,
  ): Promise<StepResult | null> {
    const t = this.snapshot(sessionId)
    const targets = this.buildTargets(sessionId)

    if (!this.brain) {
      this.pause(
        sessionId,
        'coordinator_unconfigured',
        '协调者未配置：本轮暂停，等待人类下一步指示（委托回路已就绪，等待大脑接入）',
      )
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'coordinator_unconfigured' }
    }

    // 自治预算闸门：每次决策调用（委托/继续）都消耗 1 个动作，先记账。
    const budget = this.currentBudget()
    if (t.autonomousActions >= budget) {
      this.pause(
        sessionId,
        'budget_exhausted',
        `本回合自治预算（${budget} 次自主动作）已用完，等待人类`,
      )
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'budget_exhausted' }
    }
    t.autonomousActions++
    t.decisionCalls++

    let raw: string
    try {
      raw = await this.brain.plan({
        sessionId,
        authorId,
        humanText,
        mentionHints,
        targets,
      })
    } catch (e) {
      this.pause(sessionId, 'coordinator_error', `协调者调用失败，已暂停（不猜）：${(e as Error).message}`)
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'coordinator_error' }
    }
    if (raw == null) {
      this.pause(sessionId, 'coordinator_empty', '协调者返回了空结果，已暂停（不猜）')
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'coordinator_empty' }
    }

    const parsed = parseCoordinatorOutput(raw, { humanText, targets })
    if (parsed.warned) {
      this.ctx.logger.warn('[orchestrator] 兜底触发（%s）：%s；原文：%s', `L${parsed.level}`, parsed.note, raw)
    }

    const { reply, reason, delegate } = parsed.decision

    // 无委托：协调者回复落到事件流（a_coordinator 的发言）。IM 化改造
    // （2026-09-30）：这不是错误 —— 回合**自然收敛**（completed），不再是
    // await_human 默认路径。
    if (!delegate) {
      // 回声抑制（2026-10-05）：Agent 成果回流续步时，大脑常把成果原文当
      // reply 复述一遍 —— 时间线已有原文，逐字重复就是噪音。这里做最后一道
      // 闸：reply 与触发文本（归一空白后）相同则不落时间线。
      const norm = (x: string) => x.replace(/\s+/gu, '')
      if (reply && norm(reply) !== norm(humanText)) this.sayCoordinator(sessionId, reply)
      const empty = raw.trim() === ''
      if (empty) {
        this.pause(sessionId, 'coordinator_empty', '协调者返回空输出，已暂停（不猜）')
        return { case: 'coordinator_error', reply, delegation: null, reason: 'coordinator_empty' }
      }
      this.pause(sessionId, 'completed', '回合完成：无未完成委托且协调者不再继续')
      return { case: 'replied', reply, delegation: null, reason: reason || parsed.note }
    }

    // 名单外目标：拒绝并暂停（幻觉/越权 —— 拒绝的判据在这里，解析器只转述）。
    if (!isAuthorizedTarget(delegate.target, targets)) {
      this.sayCoordinator(
        sessionId,
        reply || `委托目标「${delegate.target}」不在授权名单（${targets.join('、')||'无'}）内，已拒绝。`,
      )
      this.pause(sessionId, 'invalid_target', `协调者委托了不可授权的目标 "${delegate.target}"，已拒绝并暂停`)
      return { case: 'invalid_target', reply, delegation: null, reason: 'invalid_target' }
    }

    // 同一回合内同一目标只能有一笔在途委托。前一笔已完成会被从账本划掉
    // （见 reportFeedback / reportCodingResult），只有**真正重复**才拦。
    if (t.delegatedTargets.includes(delegate.target)) {
      this.pause(sessionId, 'duplicate_target', `本轮已委托过 "${delegate.target}"，重复委托已拒绝`)
      return { case: 'invalid_target', reply, delegation: null, reason: 'duplicate_target' }
    }

    // 合法委托：先宣告（调用前必须输出），后记账。保持 chain 等结果回流
    // （IM 化改造：不再强制暂停，agent 事件回流 → handleAgentEvent 续步）。
    t.delegatedTargets.push(delegate.target)
    // 宣告 + 大脑附言（P8）：大脑 reply 非空时随宣告落时间线。
    // verify-orchestrator A5b 用 startsWith 前缀口径，附言追加不破坏断言。
    this.sayCoordinator(
      sessionId,
      `已收到指令，将委托[${delegate.target}]：${delegate.instruction || humanText}` +
        (reply ? `\n（大脑附言：${reply}）` : ''),
    )
    // 消费委托（P6 收尾）：把委托交执行链 —— emit 内核事件，订阅方（
    // agent-coder-stub 等）认领自己名下的 target 真正干活，干完走收执口
    // 回报。引擎只决策不执行（职责分家）。
    const delegated: DelegatePayload = {
      sessionId,
      eventId,
      target: delegate.target,
      instruction: delegate.instruction || humanText,
    }
    this.ctx.emit('orchestrator/delegate', delegated)
    return { case: 'delegated', reply, delegation: delegate, reason }
  }

  /**
   * agent 事件回流（IM 化改造，2026-09-30）：结果落时间线后引擎决定是否
   * 继续自治。协调者自己的发言不回流（防自激循环）；会话不在 chain（已
   * completed / 错误停机 / 无回合）不续步。
   */
  handleAgentEvent(event: SessionEvent): void {
    if (event.authorKind !== 'agent') return
    const t = this.turns.get(event.sessionId)
    if (!t || t.state !== 'chain') return
    // 协调者本人的宣告/回复是 agent 事件，但不是"结果"—— 跳过防自激。
    const coordinator = this.ctx.session
      .listMembers(event.sessionId, true)
      .find((m) => m.role === '协调者')
    if (coordinator && event.authorId === coordinator.principalId) return
    this.continueTurn(event.sessionId, event)
  }

  /** 结果回流续步：串行化（同一会话一次只有一个续步），不计入 Plan 触发。 */
  private continueTurn(sessionId: string, event: SessionEvent): void {
    if (this.continuing.has(sessionId) || this.inFlight.has(sessionId)) return
    this.continuing.add(sessionId)
    void this.decide(sessionId, event.authorId ?? '', event.text, event.mentions, event.id)
      .catch((e: unknown) => {
        this.ctx.logger.error('[orchestrator] 回流续步失败（会话 %s）：%s', sessionId, (e as Error).message)
      })
      .finally(() => {
        this.continuing.delete(sessionId)
      })
  }

  reportFeedback(sessionId: string, target: string, text: string): SessionEvent {
    // 账本单一真相源（2026-10-01 竞态修复）：流程轨委托（beginExternalDelegate）
    // 与回合收束存在时序交叠 —— 回执只认账本里有没有该目标，不卡回合状态。
    const t = this.turns.get(sessionId)
    if (!t || !t.delegatedTargets.includes(target)) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在途的 ${target} 委托，反馈无处可交`)
    }
    // 目标匹配放宽（2026-10-07）：自定义 Agent 的委托目标是**标题**，落在
    // 成员行的 duty 上（role 只是个「成员」）—— 三口径匹配：role / duty / id。
    const member = this.ctx.session
      .listMembers(sessionId, true)
      .find((m) => m.role === target || (m.duty && m.duty === target) || m.principalId === target)
    if (!member) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在册的 ${target}`)
    }
    // IM 化改造：先从在途账本划掉（该委托已交付），再落事件 —— 事件落库会
    // 同步 emit 'space/event-appended'，回流续步随即启动（预算闸门在 decide）。
    // 不再强制 await_human（废止「禁止未获新授权自动发起下一次调用」的
    // 默认性，2026-09-30 用户拍板，见 .rules/IRON-RULES.md 修订记录）。
    t.delegatedTargets = t.delegatedTargets.filter((x) => x !== target)
    return this.ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId: member.principalId,
      phaseId: null,
      authorKind: 'agent',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
  }

  /**
   * coding agent 收执口（P6 收尾）：与 reportFeedback 同一回流语义（不再
   * 强制暂停），但落事件的作者按 **coding 名册**（ctx.agents）解析。
   * 目标解析双口径（承 /tell 先例）：target 可为名册 title 或 id。
   */
  reportCodingResult(sessionId: string, target: string, text: string): SessionEvent {
    // 同 reportFeedback：账本单一真相源，不卡回合状态（流程轨时序交叠）。
    const t = this.turns.get(sessionId)
    if (!t || !t.delegatedTargets.includes(target)) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在途的 ${target} 委托，回执无处可交`)
    }
    const agent = this.ctx.agents
      .list('coding')
      .find((a) => a.descriptor.title === target || a.descriptor.id === target)
    if (!agent) {
      // 引擎授权名单与名册不同步是编程错误（授权时还在、收执时消失）。
      this.pause(sessionId, 'coding_target_unknown', `coding 名册里找不到 "${target}"，回执无法落库，已暂停`)
      throw new OrchestratorError('not_delegating', `coding 名册里没有 "${target}"（授权时它还在 —— 引擎与名册不同步）`)
    }
    // 先划账再落库：落库即 emit 回流信号，续步立刻启动（见 reportFeedback 注）。
    t.delegatedTargets = t.delegatedTargets.filter((x) => x !== target)
    return this.ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId: agent.descriptor.id,
      phaseId: null,
      authorKind: 'agent',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
  }

  /** 协调者的发言：authorId 用在册协调者的成员 id；没有在册协调者则不落事件。 */
  private sayCoordinator(sessionId: string, text: string): void {
    const coordinator = this.ctx.session
      .listMembers(sessionId, true)
      .find((m) => m.role === '协调者')
    if (!coordinator) {
      this.ctx.logger.warn('[orchestrator] 会话 %s 没有在册协调者，发言无法落事件：%s', sessionId, text)
      return
    }
    this.ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId: coordinator.principalId,
      phaseId: null,
      authorKind: 'agent',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
  }

  /**
   * 外部委托入口（流程轨，2026-10-01）：把 MC 式流程的派发登记进在途账本
   * （无回合则开新回合；已有链上回合则复用）后再发 'orchestrator/delegate'
   * —— agent 回报时 reportCodingResult/reportFeedback 才能找到账本。
   */
  beginExternalDelegate(sessionId: string, eventId: string, target: string, instruction: string): void {
    let t = this.turns.get(sessionId)
    if (!t || t.state !== 'chain') {
      t = { state: 'chain', decisionCalls: 0, autonomousActions: 0, delegatedTargets: [], stopReason: '', stopDetail: '' }
      this.turns.set(sessionId, t)
    }
    if (!t.delegatedTargets.includes(target)) t.delegatedTargets.push(target)
    this.ctx.emit('orchestrator/delegate', { sessionId, eventId, target, instruction } satisfies DelegatePayload)
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const engine = new OrchestratorEngine(ctx, config)
  // 双轨触发 —— 接缝一（/commit 兼容路径，P2 留的接缝，原样保留）：
  ctx.on('staging/plan', (payload) => {
    void engine.onPlan(payload)
  })
  // 接缝二（IM 主路径，2026-09-30）：@ 了任何 a_* 成员或会议目标角色才
  // 触发回合；纯聊天（mentions 为空 / 只 @ 人类）不打扰 AI。
  ctx.on('space/plan', (signal: PlanSignal) => {
    const members = ctx.session.listMembers(signal.sessionId, true)
    const memberIds = new Set(members.map((m) => m.principalId))
    const wantsAi = signal.mentions.some((m) => m.startsWith('a_') || memberIds.has(m))
    if (!wantsAi) return
    void engine.onPlan({ sessionId: signal.sessionId, authorId: signal.authorId, event: signal.event })
  })
  // 接缝三（结果回流，2026-09-30）：agent 事件落时间线 → 引擎按自治预算
  // 决定是否继续（exactly-once 信号源在 eventlog.append 内部，这里只消费）。
  ctx.on('space/event-appended', ({ event }) => {
    engine.handleAgentEvent(event)
  })
  // 回合状态只读口（P4 右栏「已暂停/暂停原因/调用次数」的数据源；Part B 的探针）。
  ctx.server.get('/api/sessions/:id/turn', async (req) => Response.json(engine.turn(req.params.id)))
}
