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
// 热状态保存在内存并同步快照到 SQLite settings；重启时根据回合、待决策项、
// 委托账本和 FIFO 队列恢复。协调者消息使用触发事件的稳定幂等 ID，避免崩溃
// 后重放决策时重复写入已落时间线的回复。
// 暂停原因同时 emit 'orchestrator/pause' 并落 ctx.logger（warn/详情）。
//
// 类用 TS private 字段（编译期私有）—— 不用 # 私有字段：cordis 服务代理
// 重绑 this 后 # 品牌校验必炸（2026-09-27 实测，见 seam/space-staging 头注）。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import { AGENT_REVIEW_QUESTION_MARKER, DECISION_REVIEW_REQUEST_MARKER } from 'space-event'
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
import { blockedSpeechNotice, decideAgentSpeech } from 'space-agent-speech'

export const name = 'orchestrator'
// cordis 严格注入检查：apply 里摸到的每个服务都要声明（漏了会得到
// "cannot get property without inject"，且只进 5172 日志页，不上控制台）。
// agents（P6 收尾）：coding 名册 —— 授权名单 = 会议角色 + 在册 coding agent；
// workdir/命令路径不经本插件（coder 自己用），不注入。
export const inject = ['server', 'session', 'eventLog', 'agents', 'settings', 'agentInbox', 'sessionWork', 'users']

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
const PERSISTED_STATE_KEY = 'orchestrator.runtime.v1'

interface PersistedOrchestratorState {
  version: 1
  turns: Array<[string, Turn]>
  delegations: DelegatePayload[]
  queue: Array<
    | { kind: 'plan'; payload: PlanPayload }
    | { kind: 'continue'; payload: PlanPayload }
    | { kind: 'external'; sessionId: string; eventId: string; target: string; instruction: string }
  >
  activeDecisions: Array<{ payload: PlanPayload; resetTurn: boolean }>
}

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
  private readonly decisionReviewHolds = new Set<string>()
  /** 续步串行化：同一会话的回流续步一次只有一个（防回流风暴）。 */
  private readonly continuing = new Set<string>()
  /** Persisted chain snapshots do not represent live work until replay starts. */
  private readonly recoveringSessions = new Set<string>()
  /** Exact source event for each outstanding Agent task; consumed at result append. */
  private readonly delegationSources = new Map<string, string>()
  private readonly delegationPayloads = new Map<string, DelegatePayload>()
  /** FIFO of accepted orchestration and deterministic flow work. */
  private readonly workQueue: Array<
    | { kind: 'plan'; payload: PlanPayload }
    | { kind: 'continue'; payload: PlanPayload }
    | { kind: 'external'; sessionId: string; eventId: string; target: string; instruction: string }
  > = []
  /** Decisions stay here while the brain is deciding, so a process crash can retry them. */
  private readonly activeDecisions = new Map<string, { payload: PlanPayload; resetTurn: boolean }>()
  private readonly queuedEventIds = new Set<string>()
  private drainScheduled = false
  private recoveryPending = false
  private brain: OrchestratorBrain | null = null
  private readonly budget: number

  private delegationKey(sessionId: string, target: string): string {
    return `${sessionId}\u0000${target}`
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.budget = config.autonomyBudget ?? DEFAULT_BUDGET
    this.hydrateState()
  }

  private hydrateState(): void {
    try {
      const stored = this.ctx.settings?.get<PersistedOrchestratorState | null>(PERSISTED_STATE_KEY, null)
      if (!stored || stored.version !== 1) return
      for (const [sessionId, turn] of stored.turns ?? []) {
        if (sessionId && turn && Array.isArray(turn.delegatedTargets)) this.turns.set(sessionId, turn)
      }
      for (const payload of stored.delegations ?? []) {
        if (!payload?.sessionId || !payload.eventId || !payload.target) continue
        const key = this.delegationKey(payload.sessionId, payload.target)
        this.delegationSources.set(key, payload.eventId)
        this.delegationPayloads.set(key, payload)
      }
      this.workQueue.push(...(stored.queue ?? []))
      for (const item of this.workQueue) {
        this.queuedEventIds.add(item.kind === 'external' ? item.eventId : item.payload.event.id)
      }
      for (const decision of stored.activeDecisions ?? []) {
        if (decision?.payload?.event?.id) this.activeDecisions.set(decision.payload.event.id, decision)
      }
    } catch (error) {
      this.ctx.logger.error('[orchestrator] 持久回合状态无法读取，启动为静止状态：%s', (error as Error).message)
    }
  }

  /** Reload shared state after a peer already emitted the idempotent result for a queued Plan. */
  private reconcileCompletedPlan(payload: PlanPayload): boolean {
    const coordinator = this.ctx.session.listMembers(payload.sessionId, true).find((member) => member.role === '协调者')
    if (!coordinator) return false
    let completed = false
    try {
      completed = this.ctx.eventLog.listBySession(payload.sessionId).some((event) =>
        event.authorId === coordinator.principalId && event.sourceEventId === payload.event.id)
    } catch { return false }
    if (!completed) return false
    this.ctx.logger.info('[orchestrator] 丢弃其他实例已完成的 Plan（session=%s, event=%s）',
      payload.sessionId, payload.event.id)

    // A second process may have hydrated the same active decision before the
    // first process finished. Its local snapshot is now stale; reload the
    // durable turn, delegation ledger, and FIFO before allowing any replay.
    this.turns.clear()
    this.delegationSources.clear()
    this.delegationPayloads.clear()
    this.workQueue.length = 0
    this.activeDecisions.clear()
    this.queuedEventIds.clear()
    this.recoveringSessions.clear()
    this.hydrateState()
    this.activeDecisions.delete(payload.event.id)
    for (let index = this.workQueue.length - 1; index >= 0; index--) {
      const item = this.workQueue[index]!
      if (item.kind !== 'external' && item.payload.event.id === payload.event.id) this.workQueue.splice(index, 1)
    }
    this.queuedEventIds.delete(payload.event.id)

    // Release the short replay-check lease. Persisted delegations and remaining
    // queued work are then recovered from the now-current shared snapshot.
    try { this.ctx.sessionWork.leave(payload.sessionId, `orchestrator:${payload.sessionId}`) }
    catch { /* standalone engine verifiers may omit the shared scheduler */ }
    this.recoverPersistedWork()
    this.scheduleQueueDrain()
    return true
  }

  private persistState(): boolean {
    try {
      if (!this.ctx.settings?.set) return true // isolated engine verifiers may omit persistence
      const state: PersistedOrchestratorState = {
        version: 1,
        turns: [...this.turns.entries()],
        delegations: [...this.delegationPayloads.values()],
        queue: this.workQueue,
        activeDecisions: [...this.activeDecisions.values()],
      }
      this.ctx.settings.set(PERSISTED_STATE_KEY, state)
      return true
    } catch (error) {
      this.ctx.logger.error('[orchestrator] 持久回合状态写入失败：%s', (error as Error).message)
      return false
    }
  }

  /** Requeue crash-interrupted decisions and delegates after the global slot is free. */
  recoverPersistedWork(): void {
    try {
      if (this.ctx.sessionWork.state().activeSessionId) {
        this.recoveryPending = true
        return
      }
    } catch { /* standalone engine verifier has no shared scheduler */ }
    this.recoveryPending = false
    for (const { payload, resetTurn } of this.activeDecisions.values()) {
      this.recoveringSessions.add(payload.sessionId)
      const restoredTurn = this.turns.get(payload.sessionId)
      if (restoredTurn?.state === 'static' && restoredTurn.stopReason) {
        this.activeDecisions.delete(payload.event.id)
        continue
      }
      if ([...this.delegationPayloads.values()].some((item) => item.eventId === payload.event.id)) {
        this.activeDecisions.delete(payload.event.id)
      } else if (!this.queuedEventIds.has(payload.event.id)) {
        this.queuedEventIds.add(payload.event.id)
        this.workQueue.unshift({ kind: resetTurn ? 'plan' : 'continue', payload })
      }
    }
    for (const payload of this.delegationPayloads.values()) {
      this.recoveringSessions.add(payload.sessionId)
      const events = this.ctx.eventLog.listBySession(payload.sessionId)
      const result = events.find((event) => this.isDelegateResult(payload, event))
      if (result) {
        this.settleDelegation(payload.sessionId, payload.target)
        if (!result.voided && result.authorKind === 'agent') this.handleAgentEvent(result)
        continue
      }
      if (this.queuedEventIds.has(payload.eventId)) continue
      this.queuedEventIds.add(payload.eventId)
      this.workQueue.unshift({ kind: 'external', sessionId: payload.sessionId, eventId: payload.eventId,
        target: payload.target, instruction: payload.instruction })
    }
    // A crash can persist a chain turn after its active decision/delegation was
    // already removed. Such a turn has nothing left to replay, but activeSession()
    // would otherwise treat it as busy forever and strand every later session.
    const recoverableSessions = new Set<string>([
      ...[...this.activeDecisions.values()].map(({ payload }) => payload.sessionId),
      ...[...this.delegationPayloads.values()].map(({ sessionId }) => sessionId),
      ...this.workQueue.map((item) => item.kind === 'external' ? item.sessionId : item.payload.sessionId),
    ])
    const orphaned: string[] = []
    for (const [sessionId, turn] of this.turns) {
      if (turn.state !== 'chain' || recoverableSessions.has(sessionId)) continue
      turn.state = 'static'
      turn.stopReason = 'recovery_orphaned'
      turn.stopDetail = '进程恢复时没有找到可恢复的决策、委托或队列任务；已暂停该回合并释放会话槽位。'
      this.recoveringSessions.delete(sessionId)
      orphaned.push(sessionId)
    }
    this.persistState()
    for (const sessionId of orphaned) {
      const turn = this.turns.get(sessionId)!
      this.ctx.emit('orchestrator/pause', { sessionId, stopReason: turn.stopReason, stopDetail: turn.stopDetail })
      this.ctx.logger.warn('[orchestrator] 恢复时暂停无可恢复任务的遗留回合（session=%s）', sessionId)
      this.releaseSessionIfIdle(sessionId)
    }
    this.scheduleQueueDrain()
  }

  private settleDelegation(sessionId: string, target: string): void {
    const key = this.delegationKey(sessionId, target)
    this.delegationSources.delete(key)
    this.delegationPayloads.delete(key)
    const turn = this.turns.get(sessionId)
    if (turn) turn.delegatedTargets = turn.delegatedTargets.filter((name) => name !== target)
    this.persistState()
  }

  private isDelegateResult(payload: DelegatePayload, event: SessionEvent): boolean {
    if (event.authorKind !== 'agent' ||
      (event.sourceEventId !== payload.eventId && !event.sourceEventIds.includes(payload.eventId))) return false
    const member = this.ctx.session.listMembers(payload.sessionId, true).find((item) =>
      item.principalId === payload.target || item.role === payload.target || item.duty === payload.target)
    if (member?.principalId === event.authorId) return true
    try {
      return this.ctx.agents.list().some((agent) =>
        (agent.descriptor.title === payload.target || agent.descriptor.id === payload.target) &&
        agent.descriptor.id === event.authorId)
    } catch { return false }
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
    const current = { ...this.turns.get(sessionId) ?? staticTurn() }
    if (this.hasPendingHumanDecision(sessionId) && current.stopReason !== 'await_human_decision') {
      current.state = 'static'
      current.stopReason = 'await_human_decision'
      current.stopDetail = 'Agent 提出需要人类决定的建议；依赖后续工作已暂停，等待 DRI 命令'
    }
    return current
  }

  private snapshot(sessionId: string): Turn {
    let t = this.turns.get(sessionId)
    if (!t) {
      t = staticTurn()
      this.turns.set(sessionId, t)
    }
    return t
  }

  private releaseSessionIfIdle(sessionId: string): void {
    if (this.turns.get(sessionId)?.state === 'chain' || this.inFlight.has(sessionId) || this.continuing.has(sessionId)) return
    try { this.ctx.sessionWork.leave(sessionId, `orchestrator:${sessionId}`) } catch { /* optional in isolated harnesses */ }
  }

  /** 无条件进入静止 + 广播 + 留日志（承旧 Engine.Pause：异常分支结尾必须调用）。 */
  private pause(sessionId: string, stopReason: string, stopDetail: string): void {
    const t = this.snapshot(sessionId)
    t.state = 'static'
    t.stopReason = stopReason
    t.stopDetail = stopDetail
    this.persistState()
    const payload: PausePayload = { sessionId, stopReason, stopDetail }
    this.ctx.emit('orchestrator/pause', payload)
    this.releaseSessionIfIdle(sessionId)
    this.ctx.logger.warn('[orchestrator] 暂停（%s）：%s', stopReason, stopDetail)
    this.scheduleQueueDrain()
  }

  pauseForDecisionReview(sessionId: string, detail: string): void {
    this.decisionReviewHolds.add(sessionId)
    this.pause(sessionId, 'await_human_decision', detail)
  }

  resolveDecisionReview(sessionId: string): void {
    this.decisionReviewHolds.delete(sessionId)
    this.scheduleQueueDrain()
  }

  private activeSession(except?: string): string | null {
    try {
      const shared = this.ctx.sessionWork.state().activeSessionId
      if (shared && shared !== except) return shared
    } catch { /* scheduler may be absent in isolated verifier contexts */ }
    const chained = [...this.turns.entries()].find(([sid, turn]) => sid !== except &&
      !this.recoveringSessions.has(sid) && turn.state === 'chain')
    if (chained) return chained[0]
    const busy = [...this.inFlight, ...this.continuing].find((sid) => sid !== except)
    if (busy) return busy
    try {
      const agent = this.ctx.agents.list().find((entry) => entry.status === 'working')
      if (agent) return `Agent「${agent.descriptor.title}」`
    } catch { /* registry may not be mounted in isolated verifier contexts */ }
    return null
  }

  private enqueue(payload: PlanPayload, reason: string): null {
    const { sessionId, event } = payload
    if (!this.queuedEventIds.has(event.id)) {
      this.queuedEventIds.add(event.id)
      this.workQueue.push({ kind: 'plan', payload })
      if (!this.persistState()) {
        this.workQueue.pop()
        this.queuedEventIds.delete(event.id)
        this.ctx.logger.error('[orchestrator] 持久队列不可用，任务未入队（event=%s）', event.id)
        return null
      }
      try {
        const active = this.ctx.sessionWork.state().activeSessionId
        if (active && active !== sessionId) this.ctx.sessionWork.tryEnter(sessionId, 'orchestrator-queue')
      } catch { /* optional in isolated verifier contexts */ }
      const position = this.workQueue.length
      this.ctx.logger.info('[orchestrator] 会话 %s 的 Agent 任务进入队列（位置 %d）：%s', sessionId, position, reason)
      try {
        this.ctx.eventLog.append({
          id: randomUUID(), sessionId, authorId: null, phaseId: null,
          authorKind: 'system', kind: 'system',
          text: `⏳ Agent 任务已排队（第 ${position} 位）：${reason}。当前消息已保留，空闲后自动处理。`,
          mentions: [], toolCalls: [], replyMode: '',
        })
      } catch (e) {
        this.workQueue.pop()
        this.queuedEventIds.delete(event.id)
        this.persistState()
        try { this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue') } catch { /* optional in isolated verifier contexts */ }
        this.ctx.logger.error('[orchestrator] 排队状态无法留痕，任务未入队（%s）', (e as Error).message)
      }
    }
    return null
  }

  private scheduleQueueDrain(): void {
    if (this.drainScheduled || this.workQueue.length === 0) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      if (this.activeSession()) return
      const nextIndex = this.workQueue.findIndex((item) => {
        const sid = item.kind === 'external' ? item.sessionId : item.payload.sessionId
        return !this.decisionReviewHolds.has(sid)
      })
      if (nextIndex < 0) return
      const [next] = this.workQueue.splice(nextIndex, 1)
      if (!next) return
      const sessionId = next.kind === 'external' ? next.sessionId : next.payload.sessionId
      const eventId = next.kind === 'external' ? next.eventId : next.payload.event.id
      this.queuedEventIds.delete(eventId)
      // Keep the durable queue row until the called handler atomically replaces
      // it with an active decision/delegation snapshot in its first synchronous step.
      try {
        this.ctx.eventLog.append({
          id: randomUUID(), sessionId, authorId: null, phaseId: null,
          authorKind: 'system', kind: 'system', text: '▶ 排队任务开始处理。',
          mentions: [], toolCalls: [], replyMode: '',
        })
      } catch { /* the queued request still runs; service logger records failures */ }
      if (next.kind === 'plan') {
        this.recoveringSessions.delete(sessionId)
        try { this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue') } catch { /* optional in isolated verifier contexts */ }
        void this.onPlan(next.payload).catch((e: unknown) => {
          this.ctx.logger.error('[orchestrator] 排队任务启动失败（会话 %s）：%s', sessionId, (e as Error).message)
        }).finally(() => this.scheduleQueueDrain())
      } else if (next.kind === 'continue') {
        this.recoveringSessions.delete(sessionId)
        this.resumeContinuation(next.payload)
        this.scheduleQueueDrain()
      } else {
        this.recoveringSessions.delete(sessionId)
        this.startExternalDelegate(next.sessionId, next.eventId, next.target, next.instruction)
        this.scheduleQueueDrain()
      }
    })
  }

  /** Wake the local FIFO after the shared session gate changes. */
  wakeQueue(): void {
    if (this.recoveryPending) this.recoverPersistedWork()
    this.scheduleQueueDrain()
  }

  async onPlan(payload: PlanPayload): Promise<StepResult | null> {
    const { sessionId, authorId, event } = payload
    if (this.decisionReviewHolds.has(sessionId) || this.hasPendingHumanDecision(sessionId)) {
      return this.enqueue(payload, '会话有 Agent 建议正在等待 DRI 决策')
    }
    // 同一会话的并发 Plan 也按到达顺序排队，不丢掉被人类明确 @ 的任务。
    if (this.inFlight.has(sessionId) || this.continuing.has(sessionId)) {
      return this.enqueue(payload, `会话 ${sessionId} 正在处理前序任务`)
    }
    const active = this.activeSession(sessionId)
    if (active) return this.enqueue(payload, `${active} 正在处理其它任务`)
    try {
      if (!this.ctx.sessionWork.tryEnter(sessionId, `orchestrator:${sessionId}`)) {
        const owner = this.ctx.sessionWork.state().activeSessionId ?? '其他会话'
        return this.enqueue(payload, `${owner} 正在处理其它任务`)
      }
    } catch { /* retain standalone engine support for isolated verifier contexts */ }
    if (this.reconcileCompletedPlan(payload)) return null
    this.inFlight.add(sessionId)
    this.activeDecisions.set(event.id, { payload, resetTurn: true })
    if (!this.persistState()) {
      this.activeDecisions.delete(event.id)
      this.inFlight.delete(sessionId)
      this.pause(sessionId, 'state_persistence_failed', '回合状态无法持久化，未开始协调者调用')
      return null
    }
    try {
      return await this.planOnce(payload)
    } finally {
      this.inFlight.delete(sessionId)
      this.activeDecisions.delete(event.id)
      this.persistState()
      this.releaseSessionIfIdle(sessionId)
      this.scheduleQueueDrain()
    }
  }

  private hasPendingHumanDecision(sessionId: string): boolean {
    let events: SessionEvent[]
    try { events = this.ctx.eventLog.listBySession(sessionId) }
    catch { return false }
    const reviewPending = events.some((request) => request.kind === 'decision' && !request.voided &&
      request.text.startsWith(DECISION_REVIEW_REQUEST_MARKER) &&
      !events.some((decision) => decision.replyTo === request.replyTo && decision.seq > request.seq &&
        (decision.kind === 'approval' || decision.kind === 'decision') &&
        decision.text.startsWith('DRI 决策：') && !decision.text.includes('DRI 决策：暂缓')))
    return reviewPending || events.some((event) => {
      if (event.authorKind !== 'agent' || event.kind !== 'message' || event.voided ||
        !event.text.includes('【需要DRI决策】')) return false
      return !events.some((decision) => decision.replyTo === event.id &&
        (decision.kind === 'approval' || decision.kind === 'decision') &&
        decision.text.startsWith('DRI 决策：') && !decision.text.includes('DRI 决策：暂缓'))
    })
  }

  /** 授权名单 = 会议三机器人角色（policy 纯函数）+ 在册 coding agent 名册。 */
  private buildTargets(sessionId: string): string[] {
    const meetingTargets = authorizedTargets(this.ctx.session.listMembers(sessionId, true))
    let codingTargets: string[] = []
    try {
      codingTargets = this.ctx.agents.list()
        .filter((agent) => agent.descriptor.kind === 'coding' || agent.descriptor.kind === 'custom')
        .map((agent) => agent.descriptor.title)
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
    this.persistState()
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
    this.persistState()

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
      if (reply && norm(reply) !== norm(humanText)) this.sayCoordinator(sessionId, reply, eventId)
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
        eventId,
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
    const key = this.delegationKey(sessionId, delegate.target)
    const delegated: DelegatePayload = {
      sessionId,
      eventId,
      target: delegate.target,
      instruction: delegate.instruction || humanText,
    }
    this.delegationSources.set(key, eventId)
    this.delegationPayloads.set(key, delegated)
    if (!this.persistState()) {
      this.delegationSources.delete(key)
      this.delegationPayloads.delete(key)
      t.delegatedTargets = t.delegatedTargets.filter((target) => target !== delegate.target)
      this.pause(sessionId, 'state_persistence_failed', '回合状态无法持久化，未派发 Agent 任务')
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'state_persistence_failed' }
    }
    // 宣告 + 大脑附言（P8）：大脑 reply 非空时随宣告落时间线。
    // verify-orchestrator A5b 用 startsWith 前缀口径，附言追加不破坏断言。
    this.sayCoordinator(
      sessionId,
      `已收到指令，将委托[${delegate.target}]：${delegate.instruction || humanText}` +
        (reply ? `\n（大脑附言：${reply}）` : ''),
      eventId,
    )
    // 消费委托（P6 收尾）：把委托交执行链 —— emit 内核事件，订阅方（
    // agent-coder-stub 等）认领自己名下的 target 真正干活，干完走收执口
    // 回报。引擎只决策不执行（职责分家）。
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
    if (event.text.startsWith(AGENT_REVIEW_QUESTION_MARKER)) return
    if (event.sourceEventId || event.sourceEventIds.length) {
      for (const payload of this.delegationPayloads.values()) {
        if (payload.sessionId === event.sessionId && this.isDelegateResult(payload, event)) {
          this.activeDecisions.set(event.id, {
            payload: { sessionId: event.sessionId, authorId: event.authorId ?? '', event },
            resetTurn: false,
          })
          this.persistState()
          this.settleDelegation(event.sessionId, payload.target)
        }
      }
    }
    const t = this.turns.get(event.sessionId)
    if (!t || t.state !== 'chain') return
    if (event.kind === 'message' && event.text.includes('【需要DRI决策】')) {
      this.pause(event.sessionId, 'await_human_decision', 'Agent 提出需要人类决定的建议；依赖后续工作已暂停，等待 DRI 命令')
      return
    }
    // 协调者本人的宣告/回复是 agent 事件，但不是"结果"—— 跳过防自激。
    const coordinator = this.ctx.session
      .listMembers(event.sessionId, true)
      .find((m) => m.role === '协调者')
    if (coordinator && event.authorId === coordinator.principalId) return
    this.continueTurn(event.sessionId, event)
  }

  /** 结果回流续步：串行化（同一会话一次只有一个续步），不计入 Plan 触发。 */
  private continueTurn(sessionId: string, event: SessionEvent): void {
    this.resumeContinuation({ sessionId, authorId: event.authorId ?? '', event })
  }

  private resumeContinuation(payload: PlanPayload): void {
    const { sessionId, event } = payload
    if (this.continuing.has(sessionId) || this.inFlight.has(sessionId)) return
    let active: string | null = null
    try { active = this.ctx.sessionWork.state().activeSessionId } catch { /* standalone verifier */ }
    if (active && active !== sessionId) {
      if (!this.queuedEventIds.has(event.id)) {
        this.queuedEventIds.add(event.id)
        this.workQueue.push({ kind: 'continue', payload })
        this.persistState()
      }
      return
    }
    try {
      if (!this.ctx.sessionWork.tryEnter(sessionId, `orchestrator:${sessionId}`)) {
        if (!this.queuedEventIds.has(event.id)) {
          this.queuedEventIds.add(event.id)
          this.workQueue.push({ kind: 'continue', payload })
          this.persistState()
        }
        return
      }
    } catch { /* standalone engine verifier has no shared scheduler */ }
    this.continuing.add(sessionId)
    this.activeDecisions.set(event.id, { payload, resetTurn: false })
    if (!this.persistState()) {
      this.activeDecisions.delete(event.id)
      this.continuing.delete(sessionId)
      this.pause(sessionId, 'state_persistence_failed', '回合状态无法持久化，未继续协调者调用')
      return
    }
    void this.decide(sessionId, payload.authorId, event.text, event.mentions, event.id)
      .catch((e: unknown) => {
        this.ctx.logger.error('[orchestrator] 回流续步失败（会话 %s）：%s', sessionId, (e as Error).message)
      })
      .finally(() => {
        this.activeDecisions.delete(event.id)
        this.persistState()
        this.continuing.delete(sessionId)
        this.releaseSessionIfIdle(sessionId)
        this.scheduleQueueDrain()
      })
  }

  reportFeedback(sessionId: string, target: string, text: string, sourceEventIds: string[] = []): SessionEvent {
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
    const sourceEventId = this.delegationSources.get(this.delegationKey(sessionId, target))
    const result = this.appendAgentReply({
      sessionId, agentId: member.principalId, title: member.duty || member.role,
      text, sourceEventId: sourceEventId ?? null, sourceEventIds,
    })
    this.settleDelegation(sessionId, target)
    return result
  }

  private appendAgentReply(input: {
    sessionId: string; agentId: string; title: string; text: string;
    sourceEventId: string | null; sourceEventIds: string[];
  }): SessionEvent {
    const history = this.ctx.eventLog.listBySession(input.sessionId)
    // Long-term Agent memory may cite events from other sessions. Those sources
    // can inform the answer, but event-log causality is intentionally scoped to
    // one session so recall/redo cannot cross session boundaries.
    const activeSessionSources = new Set(history.filter((event) => !event.voided).map((event) => event.id))
    const requestedSources = [...new Set(input.sourceEventIds)]
    const sourceEventIds = requestedSources.filter((id) => activeSessionSources.has(id))
    const omittedSources = requestedSources.length - sourceEventIds.length
    if (omittedSources > 0) {
      this.ctx.logger.warn(
        '[orchestrator] 忽略不属于当前会话或已撤回的上下文来源（session=%s, agent=%s, count=%d）',
        input.sessionId, input.agentId, omittedSources,
      )
    }
    let speechPolicy: string | undefined
    try { speechPolicy = this.ctx.agents.get(input.agentId).descriptor.speechPolicy }
    catch { /* unregistered system identities stay passive-only */ }
    const decision = decideAgentSpeech(input.agentId, speechPolicy, input.sourceEventId, history)
    if (!decision.allowed) {
      this.ctx.logger.info('[orchestrator] Agent 主动发言被限制（agent=%s, reason=%s）', input.agentId, decision.reason)
      return this.ctx.eventLog.append({
        id: randomUUID(), sessionId: input.sessionId, authorId: null, phaseId: null,
        authorKind: 'system', kind: 'system',
        text: blockedSpeechNotice(input.title, decision.reason!),
        mentions: [], toolCalls: [], replyMode: '',
      })
    }
    return this.ctx.eventLog.append({
      id: randomUUID(),
      sessionId: input.sessionId,
      authorId: input.agentId,
      phaseId: null,
      authorKind: 'agent',
      kind: 'message',
      text: input.text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
      sourceEventId: input.sourceEventId,
      sourceEventIds,
    })
  }

  /**
   * coding agent 收执口（P6 收尾）：与 reportFeedback 同一回流语义（不再
   * 强制暂停），但落事件的作者按 **coding 名册**（ctx.agents）解析。
   * 目标解析双口径（承 /tell 先例）：target 可为名册 title 或 id。
   */
  reportAgentResult(sessionId: string, target: string, text: string, sourceEventIds: string[] = []): SessionEvent {
    // 同 reportFeedback：账本单一真相源，不卡回合状态（流程轨时序交叠）。
    const t = this.turns.get(sessionId)
    if (!t || !t.delegatedTargets.includes(target)) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在途的 ${target} 委托，回执无处可交`)
    }
    const agent = this.ctx.agents
      .list()
      .find((a) => a.descriptor.title === target || a.descriptor.id === target)
    if (!agent) {
      // 引擎授权名单与名册不同步是编程错误（授权时还在、收执时消失）。
      this.pause(sessionId, 'agent_target_unknown', `Agent 名册里找不到 "${target}"，回执无法落库，已暂停`)
      throw new OrchestratorError('not_delegating', `Agent 名册里没有 "${target}"（授权时它还在 —— 引擎与名册不同步）`)
    }
    // 先划账再落库：落库即 emit 回流信号，续步立刻启动（见 reportFeedback 注）。
    const sourceEventId = this.delegationSources.get(this.delegationKey(sessionId, target))
    const result = this.appendAgentReply({
      sessionId, agentId: agent.descriptor.id, title: agent.descriptor.title,
      text, sourceEventId: sourceEventId ?? null, sourceEventIds,
    })
    this.settleDelegation(sessionId, target)
    return result
  }

  cancelDelegatedTask(sessionId: string, target: string, sourceEventId: string): boolean {
    const key = this.delegationKey(sessionId, target)
    if (this.delegationSources.get(key) !== sourceEventId) return false
    this.delegationSources.delete(key)
    this.delegationPayloads.delete(key)
    const turn = this.turns.get(sessionId)
    if (turn) turn.delegatedTargets = turn.delegatedTargets.filter((name) => name !== target)
    this.persistState()
    this.ctx.logger.info('[orchestrator] 已取消失效来源上的 Agent 委托（session=%s, target=%s, source=%s）',
      sessionId, target, sourceEventId)
    this.releaseSessionIfIdle(sessionId)
    return true
  }

  cancelDelegationsBySource(sessionId: string, sourceEventId: string): string[] {
    const prefix = `${sessionId}\u0000`
    const cancelled: string[] = []
    for (const [key, source] of this.delegationSources) {
      if (source !== sourceEventId || !key.startsWith(prefix)) continue
      const target = key.slice(prefix.length)
      this.delegationSources.delete(key)
      this.delegationPayloads.delete(key)
      cancelled.push(target)
    }
    const turn = this.turns.get(sessionId)
    if (turn && cancelled.length) {
      turn.delegatedTargets = turn.delegatedTargets.filter((target) => !cancelled.includes(target))
      this.ctx.logger.info('[orchestrator] 清除失效来源的委托账本（session=%s, source=%s, targets=%s）',
        sessionId, sourceEventId, cancelled.join(','))
      this.releaseSessionIfIdle(sessionId)
    }
    this.persistState()
    return cancelled
  }

  /** Compatibility alias for the original built-in coding plugins. */
  reportCodingResult(sessionId: string, target: string, text: string): SessionEvent {
    return this.reportAgentResult(sessionId, target, text)
  }

  /** 协调者的发言：authorId 用在册协调者的成员 id；没有在册协调者则不落事件。 */
  private sayCoordinator(sessionId: string, text: string, sourceEventId?: string): void {
    const coordinator = this.ctx.session
      .listMembers(sessionId, true)
      .find((m) => m.role === '协调者')
    if (!coordinator) {
      this.ctx.logger.warn('[orchestrator] 会话 %s 没有在册协调者，发言无法落事件：%s', sessionId, text)
      return
    }
    const id = sourceEventId ? `orchestrator_reply_${sourceEventId}` : randomUUID()
    if (sourceEventId && this.ctx.eventLog.listBySession(sessionId).some((event) => event.id === id)) return
    this.ctx.eventLog.append({
      id,
      sessionId,
      authorId: coordinator.principalId,
      phaseId: null,
      authorKind: 'agent',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
      sourceEventId: sourceEventId ?? null,
    })
  }

  /**
   * 外部委托入口（流程轨，2026-10-01）：把 MC 式流程的派发登记进在途账本
   * （无回合则开新回合；已有链上回合则复用）后再发 'orchestrator/delegate'
   * —— agent 回报时 reportCodingResult/reportFeedback 才能找到账本。
   */
  beginExternalDelegate(sessionId: string, eventId: string, target: string, instruction: string): void {
    try {
      const shared = this.ctx.sessionWork.state()
      if (shared.activeSessionId && shared.activeSessionId !== sessionId) {
        this.ctx.sessionWork.tryEnter(sessionId, 'orchestrator-queue')
        if (this.queuedEventIds.has(eventId)) return
        this.queuedEventIds.add(eventId)
        this.workQueue.push({ kind: 'external', sessionId, eventId, target, instruction })
        if (!this.persistState()) {
          this.workQueue.pop()
          this.queuedEventIds.delete(eventId)
          this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue')
          this.ctx.logger.error('[orchestrator] 持久队列不可用，流程未入队（event=%s）', eventId)
          return
        }
        const position = this.workQueue.length
        try {
          this.ctx.eventLog.append({
            id: randomUUID(), sessionId, authorId: null, phaseId: null,
            authorKind: 'system', kind: 'system',
            text: `⏳ Agent 流程任务已排队（第 ${position} 位），当前会话空闲后自动处理。`,
            mentions: [], toolCalls: [], replyMode: '',
          })
        } catch (error) {
          const index = this.workQueue.findIndex((item) => item.kind === 'external' && item.eventId === eventId)
          if (index >= 0) this.workQueue.splice(index, 1)
          this.queuedEventIds.delete(eventId)
          this.persistState()
          this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue')
          this.ctx.logger.error('[orchestrator] 流程排队留痕失败，任务未入队（session=%s）：%s', sessionId, (error as Error).message)
          return
        }
        this.ctx.logger.info('[orchestrator] 流程任务进入共享会话队列（session=%s, position=%d）', sessionId, position)
        return
      }
    } catch { /* optional in isolated harnesses */ }
    try { this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue') } catch { /* optional in isolated verifier contexts */ }
    this.startExternalDelegate(sessionId, eventId, target, instruction)
  }

  private startExternalDelegate(sessionId: string, eventId: string, target: string, instruction: string): void {
    this.queuedEventIds.delete(eventId)
    try { this.ctx.sessionWork.cancelQueued(sessionId, 'orchestrator-queue') } catch { /* optional in isolated verifier contexts */ }
    try {
      if (!this.ctx.sessionWork.tryEnter(sessionId, `orchestrator:${sessionId}`)) {
        if (!this.queuedEventIds.has(eventId)) {
          this.queuedEventIds.add(eventId)
          this.workQueue.push({ kind: 'external', sessionId, eventId, target, instruction })
          this.persistState()
        }
        return
      }
    } catch { /* optional in isolated harnesses */ }
    let t = this.turns.get(sessionId)
    if (!t || t.state !== 'chain') {
      t = { state: 'chain', decisionCalls: 0, autonomousActions: 0, delegatedTargets: [], stopReason: '', stopDetail: '' }
      this.turns.set(sessionId, t)
    }
    if (!t.delegatedTargets.includes(target)) t.delegatedTargets.push(target)
    const key = this.delegationKey(sessionId, target)
    const payload = { sessionId, eventId, target, instruction }
    this.delegationSources.set(key, eventId)
    this.delegationPayloads.set(key, payload)
    if (!this.persistState()) {
      this.delegationSources.delete(key)
      this.delegationPayloads.delete(key)
      t.delegatedTargets = t.delegatedTargets.filter((name) => name !== target)
      this.workQueue.push({ kind: 'external', sessionId, eventId, target, instruction })
      this.queuedEventIds.add(eventId)
      this.ctx.logger.error('[orchestrator] 流程任务状态无法持久化，保留在等待队列（event=%s）', eventId)
      return
    }
    this.ctx.emit('orchestrator/delegate', { sessionId, eventId, target, instruction } satisfies DelegatePayload)
  }
}

/** Barrier shared by the live @ route and its integration verifier. */
export async function waitForMentionedAgentHistory(
  ctx: Context,
  sessionId: string,
  mentions: readonly string[],
  seq: number,
): Promise<void> {
  const mentionedAgents = mentions.filter((id) => {
    try { ctx.agents.get(id); return true } catch { return false }
  })
  await Promise.all(mentionedAgents.map((id) => ctx.agentInbox.waitThrough(id, sessionId, seq)))
}

export function apply(ctx: Context, config: Config = {}) {
  const engine = new OrchestratorEngine(ctx, config)
  ctx.on('session-work/changed', () => engine.wakeQueue())
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
    void waitForMentionedAgentHistory(ctx, signal.sessionId, signal.mentions, signal.event.seq)
      .then(() => engine.onPlan({
      sessionId: signal.sessionId,
      authorId: signal.authorId,
      event: signal.event,
      })).catch((error: unknown) => {
      ctx.logger.error('[orchestrator] @ 回复前 Agent 消息游标追赶失败（session=%s）：%s',
        signal.sessionId, (error as Error).message)
      ctx.eventLog.append({
        id: randomUUID(), sessionId: signal.sessionId, authorId: null, phaseId: null,
        authorKind: 'system', kind: 'system',
        text: 'Agent 尚未完成此前消息的顺序处理，本次回复已暂停；请稍后重试。',
        mentions: [], toolCalls: [], replyMode: '',
      })
    })
  })
  // 接缝三（结果回流，2026-09-30）：agent 事件落时间线 → 引擎按自治预算
  // 决定是否继续（exactly-once 信号源在 eventlog.append 内部，这里只消费）。
  ctx.on('space/event-appended', ({ event }) => {
    engine.handleAgentEvent(event)
  })
  // 回合状态只读口（P4 右栏「已暂停/暂停原因/调用次数」的数据源；Part B 的探针）。
  ctx.server.get('/api/sessions/:id/turn', async (req) => {
    const headerToken = req.headers.get('authorization')
    const cookie = req.headers.get('cookie') ?? ''
    const token = headerToken?.startsWith('Bearer ')
      ? headerToken.slice(7).trim()
      : cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('space_token='))?.slice('space_token='.length) ?? ''
    let user
    try { user = await ctx.users.verifyToken(decodeURIComponent(token)) }
    catch { return Response.json({ error: 'unauthorized' }, { status: 401 }) }
    const sessionId = req.params.id
    if (user.kind !== 'human') return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!ctx.session.getSession(sessionId) || !ctx.session.listMembers(sessionId, true).some((member) => member.principalId === user.id)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json(engine.turn(sessionId))
  })
  // The application entry emits this after the entire composed manifest loads,
  // so recovered delegates cannot race Agent listeners that appear later in it.
  ctx.on('app/ready', () => {
    ctx.logger.info('[orchestrator] 应用清单就绪，恢复持久回合与队列')
    engine.recoverPersistedWork()
  }, { global: true })
}
