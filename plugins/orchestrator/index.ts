// orchestrator —— ctx.orchestrator 服务实例的提供者 + Plan 触发的接管者（P3）。
//
// 职责（MODULE-PLAN 第 4 节职责分家的引擎侧）：
//   · 回合状态机：每条人类 /commit 恰好一次大脑调用（decisionCalls=1）、
//     委托单槽位、暂停点 await_human（收到目标反馈后必须停 —— 禁止未获
//     新授权自动发起下一次调用的执行点，承旧 Engine.Pause）。
//   · 订阅 ctx.on('staging/plan') 原地接管 P2 留的接缝 —— 接缝不变，
//     seam/impl 零改动。
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
import type { SessionEvent } from 'space-event'
import { OrchestratorError, OrchestratorService } from 'space-orchestrator'
import type {
  OrchestratorBrain,
  PausePayload,
  PlanPayload,
  StepResult,
  Turn,
} from 'space-orchestrator'
import { authorizedTargets, isAuthorizedTarget, parseCoordinatorOutput } from 'space-authz'

export const name = 'orchestrator'
// cordis 严格注入检查：apply 里摸到的每个服务都要声明（漏了会得到
// "cannot get property without inject"，且只进 5172 日志页，不上控制台）。
export const inject = ['server', 'session', 'eventLog']

const now = () => new Date().toISOString()

const staticTurn = (): Turn => ({
  state: 'static',
  decisionCalls: 0,
  delegatedTargets: [],
  stopReason: '',
  stopDetail: '',
})

export class OrchestratorEngine extends OrchestratorService {
  private readonly turns = new Map<string, Turn>()
  private readonly inFlight = new Set<string>()
  private brain: OrchestratorBrain | null = null

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
    if (this.inFlight.has(sessionId)) {
      this.ctx.logger.warn('[orchestrator] 上一轮 Plan 仍在进行，忽略本次触发（会话 %s）', sessionId)
      return null
    }
    this.inFlight.add(sessionId)
    try {
      return await this.planOnce(payload)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private async planOnce({ sessionId, authorId, event }: PlanPayload): Promise<StepResult | null> {
    // 人类发言抢占：开新回合，旧停止原因清掉（承旧 BeginHumanTurn）。
    this.turns.set(sessionId, { state: 'chain', decisionCalls: 0, delegatedTargets: [], stopReason: '', stopDetail: '' })
    const t = this.snapshot(sessionId)

    const members = this.ctx.session.listMembers(sessionId, true)
    const targets = authorizedTargets(members)

    if (!this.brain) {
      this.pause(sessionId, 'coordinator_unconfigured', '协调者未配置：本轮暂停，等待人类下一步指示')
      return { case: 'coordinator_error', reply: '', delegation: null, reason: 'coordinator_unconfigured' }
    }

    // 每回合恰好一次大脑调用 —— 计数在调用前打上，失败也不重试（不猜）。
    t.decisionCalls++
    let raw: string
    try {
      raw = await this.brain.plan({
        sessionId,
        authorId,
        humanText: event.text,
        mentionHints: event.mentions,
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

    const parsed = parseCoordinatorOutput(raw, { humanText: event.text, targets })
    if (parsed.warned) {
      this.ctx.logger.warn('[orchestrator] 兜底触发（%s）：%s；原文：%s', `L${parsed.level}`, parsed.note, raw)
    }

    const { reply, reason, delegate } = parsed.decision

    // 无委托：协调者回复落到事件流（a_coordinator 的发言），随即暂停等人类。
    if (!delegate) {
      if (reply) this.sayCoordinator(sessionId, reply)
      const empty = raw.trim() === ''
      this.pause(
        sessionId,
        empty ? 'coordinator_empty' : 'await_human',
        empty ? '协调者返回空输出，已暂停（不猜）' : '协调者已暂停，等待人类下一步指示',
      )
      return {
        case: empty ? 'coordinator_error' : 'replied',
        reply,
        delegation: null,
        reason: empty ? 'coordinator_empty' : reason || parsed.note,
      }
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

    // 同一轮内同一目标只能调一次。单槽位结构下正常流不会走到这里，
    // 这道闸是给未来的多委托扩展兜底（铁律：账本在 turn.delegatedTargets）。
    if (t.delegatedTargets.includes(delegate.target)) {
      this.pause(sessionId, 'duplicate_target', `本轮已委托过 "${delegate.target}"，重复委托已拒绝`)
      return { case: 'invalid_target', reply, delegation: null, reason: 'duplicate_target' }
    }

    // 合法委托：先宣告（调用前必须输出），后记账。保持 chain 等目标反馈。
    t.delegatedTargets.push(delegate.target)
    this.sayCoordinator(
      sessionId,
      `已收到指令，将委托[${delegate.target}]：${delegate.instruction || event.text}`,
    )
    return { case: 'delegated', reply, delegation: delegate, reason }
  }

  reportFeedback(sessionId: string, target: string, text: string): SessionEvent {
    const t = this.turns.get(sessionId)
    if (!t || t.state !== 'chain' || !t.delegatedTargets.includes(target)) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在途的 ${target} 委托，反馈无处可交`)
    }
    const member = this.ctx.session
      .listMembers(sessionId, true)
      .find((m) => m.role === target)
    if (!member) {
      throw new OrchestratorError('not_delegating', `会话 ${sessionId} 没有在册的 ${target}`)
    }
    const ev = this.ctx.eventLog.append({
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
    // 铁律执行点：收到目标反馈后必须暂停 —— 禁止未获新授权自动发起下一次调用。
    // 由编排层在这里调用，不靠协调者自觉（承旧 Engine.Pause 的注释原话）。
    this.pause(sessionId, 'await_human', `${target} 已反馈，本轮暂停，等待人类下一步指示`)
    return ev
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
}

export function apply(ctx: Context) {
  const engine = new OrchestratorEngine(ctx)
  // P2 留的接缝：orchestrator 原地接管 Plan 触发。seam/impl 零改动。
  ctx.on('staging/plan', (payload) => {
    void engine.onPlan(payload)
  })
  // 回合状态只读口（P4 右栏「已暂停/暂停原因/调用次数」的数据源；Part B 的探针）。
  ctx.server.get('/api/sessions/:id/turn', async (req) => Response.json(engine.turn(req.params.id)))
}
