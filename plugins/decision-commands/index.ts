import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { AGENT_REVIEW_QUESTION_MARKER, collectAgentDescendants, DECISION_REVIEW_REQUEST_MARKER } from 'space-event'
import type { SessionEvent } from 'space-event'

export const name = 'decision-commands'
export const inject = ['commands', 'session', 'eventLog', 'agentInbox', 'agents', 'memory', 'agentRuntime', 'orchestrator']

type Action = 'pass' | 'reject' | 'modify' | 'defer' | 'recall' | 'redo'

function appendDecision(ctx: Context, sessionId: string, authorId: string, target: SessionEvent,
  action: Action, reason: string, decisionId = randomUUID()): SessionEvent {
  return ctx.eventLog.append({
    id: decisionId, sessionId, authorId, phaseId: null,
    authorKind: 'human', kind: action === 'pass' ? 'approval' : 'decision',
    text: `DRI 决策：${{ pass: '通过', reject: '否决', modify: '修改', defer: '暂缓', recall: '撤回', redo: '要求重做' }[action]}\n目标事件：${target.id}${reason ? `\n说明：${reason}` : ''}`,
    mentions: [], toolCalls: [], replyMode: '', replyTo: target.id,
  })
}

function resumeOrchestration(ctx: Context, event: SessionEvent, mentions: string[] = []): void {
  ctx.emit('space/plan', {
    sessionId: event.sessionId,
    authorId: event.authorId ?? '',
    mentions,
    event,
  })
}

async function withdraw(ctx: Context, target: SessionEvent, by: string, reason: string): Promise<{
  invalidated: number; rebuilt: number; affectedEventIds: string[]; invalidatedMemoryIds: string[]; rebuiltMemoryIds: string[]
}> {
  const consequences = new Map<string, SessionEvent>()
  let stable = false
  for (let round = 0; round < 32; round++) {
    const history = ctx.eventLog.listBySession(target.sessionId)
    for (const event of [target, ...collectAgentDescendants(history, target.id)]) consequences.set(event.id, event)
    for (const event of consequences.values()) {
      ctx.orchestrator.cancelDelegationsBySource(target.sessionId, event.id)
      const cancelled = typeof ctx.agentRuntime.cancelBySource === 'function'
        ? await ctx.agentRuntime.cancelBySource(event.id) : 0
      if (cancelled > 0) ctx.logger.info('[decision] 因果来源撤回，已中止 %d 个 Agent 运行（event=%s）', cancelled, event.id)
    }
    const throughSeq = Math.max(...[...consequences.values()].map((event) => event.seq))
    const activeMembers = ctx.session.listMembers(target.sessionId, true)
    await Promise.all(activeMembers.flatMap((member) => {
      try {
        ctx.agents.get(member.principalId)
        return [ctx.agentInbox.waitThrough(member.principalId, target.sessionId, throughSeq)]
      } catch {
        return []
      }
    }))
    const latest = [target, ...collectAgentDescendants(ctx.eventLog.listBySession(target.sessionId), target.id)]
    const added = latest.filter((event) => !consequences.has(event.id))
    for (const event of added) consequences.set(event.id, event)
    if (added.length === 0) { stable = true; break }
  }
  if (!stable) throw new Error('撤回影响链在等待期间持续变化，请稍后重试')
  let invalidated = 0
  let changedCount = 0
  const affectedEventIds: string[] = []
  const affectedMemories = new Map<string, Awaited<ReturnType<Context['memory']['invalidateBySource']>>[number]>()
  for (const event of [...consequences.values()].sort((a, b) => a.seq - b.seq)) {
    const changed = ctx.eventLog.void(event.id, by, reason)
    if (!changed) continue
    changedCount += changed
    affectedEventIds.push(event.id)
    for (const item of await ctx.memory.invalidateBySource(event.id)) affectedMemories.set(item.id, item)
  }
  if (!changedCount) throw new Error('目标已撤回或状态已变化，请刷新后重试')
  invalidated = affectedMemories.size
  const sources = new Map(ctx.session.listSessions().flatMap((session) => ctx.eventLog.listBySession(session.id))
    .filter((event) => !event.voided).map((event) => [event.id, event]))
  let rebuilt = 0
  const rebuiltMemoryIds: string[] = []
  for (const item of affectedMemories.values()) {
    if (item.sourceEventIds.length < 2 || !item.scope.startsWith('agent:')) continue
    const validSources = item.sourceEventIds.flatMap((id) => {
      const event = sources.get(id)
      return event ? [event] : []
    })
    if (validSources.length === 0) continue
    try {
      if (typeof ctx.agentInbox.rebuildInvalidatedMemory === 'function') {
        const count = await ctx.agentInbox.rebuildInvalidatedMemory(item, validSources)
        rebuilt += count
        if (count > 0) {
          const rows = await ctx.memory.recall(item.scope, { limit: 100 })
          rebuiltMemoryIds.push(...rows.filter((row) => row.kind.startsWith(`${item.kind}:rebuilt:${item.id}:`)).map((row) => row.id))
        }
      }
    } catch (error) {
      ctx.logger?.warn('[decision] 混合来源记忆重建失败（memory=%s）：%s', item.id, (error as Error).message)
    }
  }
  return { invalidated, rebuilt, affectedEventIds, invalidatedMemoryIds: [...affectedMemories.keys()], rebuiltMemoryIds }
}

function appendImpactRecord(ctx: Context, decision: SessionEvent, impact: {
  affectedEventIds: string[]; invalidatedMemoryIds: string[]; rebuiltMemoryIds: string[]
}): void {
  ctx.eventLog.append({
    id: randomUUID(), sessionId: decision.sessionId, authorId: null, phaseId: null,
    authorKind: 'system', kind: 'system', replyTo: decision.id,
    text: [
      `【决策影响记录】关联决策：${decision.id}`,
      `废止事件（${impact.affectedEventIds.length}）：${impact.affectedEventIds.join('、') || '无'}`,
      `失效记忆（${impact.invalidatedMemoryIds.length}）：${impact.invalidatedMemoryIds.join('、') || '无'}`,
      `重建记忆（${impact.rebuiltMemoryIds.length}）：${impact.rebuiltMemoryIds.join('、') || '无'}`,
    ].join('\n'),
    mentions: [], toolCalls: [], replyMode: '',
  })
}

function openReviewRequest(ctx: Context, sessionId: string, target: SessionEvent): SessionEvent | null {
  const events = ctx.eventLog.listBySession(sessionId)
  const requests = events.filter((event) => event.kind === 'decision' &&
    event.text.startsWith(DECISION_REVIEW_REQUEST_MARKER) && event.replyTo === target.id && !event.voided)
  return requests.filter((request) => !events.some((decision) => decision.replyTo === target.id &&
    decision.seq > request.seq && (decision.kind === 'approval' || decision.kind === 'decision') &&
    decision.text.startsWith('DRI 决策：') && !decision.text.includes('DRI 决策：暂缓')))
    .sort((a, b) => b.seq - a.seq)[0] ?? null
}

function reviewComplete(ctx: Context, request: SessionEvent): boolean {
  return ctx.eventLog.listBySession(request.sessionId).some((event) => event.kind === 'system' &&
    event.replyTo === request.id && event.text.startsWith('【复核完成】'))
}

async function waitForReview(ctx: Context, target: SessionEvent, request: SessionEvent): Promise<number> {
  const getAgents = () => ctx.session.listMembers(target.sessionId, true).flatMap((member) => {
    try { ctx.agents.get(member.principalId); return [member.principalId] } catch { return [] }
  })
  let stable = false
  for (let round = 0; round < 32; round++) {
    const history = ctx.eventLog.listBySession(target.sessionId)
    const chain = [target, ...collectAgentDescendants(history, target.id)]
    // Let all work already caused by this answer settle before collecting review questions.
    if (typeof ctx.agentRuntime.waitForSource === 'function') {
      await Promise.all(chain.map((event) => ctx.agentRuntime.waitForSource(event.id)))
    }
    const throughSeq = Math.max(...ctx.eventLog.listBySession(target.sessionId).map((event) => event.seq))
    const agents = getAgents()
    await Promise.all(agents.map((agentId) => ctx.agentInbox.waitThrough(agentId, target.sessionId, throughSeq)))
    const after = ctx.eventLog.listBySession(target.sessionId)
    const nextChain = [target, ...collectAgentDescendants(after, target.id)]
    const added = nextChain.some((event) => !chain.some((prior) => prior.id === event.id))
    const latest = Math.max(...after.map((event) => event.seq))
    if (!added && latest === throughSeq) { stable = true; break }
  }
  if (!stable) throw new Error('复核期间会话仍有新结果，请稍后重试')
  const questions = ctx.eventLog.listBySession(target.sessionId).filter((event) =>
    event.authorKind === 'agent' && event.text.startsWith(AGENT_REVIEW_QUESTION_MARKER) &&
    event.sourceEventId === request.id).length
  ctx.eventLog.append({
    id: randomUUID(), sessionId: target.sessionId, authorId: null, phaseId: null,
    authorKind: 'system', kind: 'system', text: `【复核完成】${questions} 个 Agent 提出问题。DRI 可阅读会话记录并重复决策命令定案。`,
    mentions: [], toolCalls: [], replyMode: '', replyTo: request.id,
  })
  return questions
}

async function startReview(ctx: Context, sessionId: string, authorId: string, target: SessionEvent,
  action: Action, reason: string): Promise<{ request: SessionEvent; questions: number }> {
  let request = openReviewRequest(ctx, sessionId, target)
  if (!request) {
    ctx.orchestrator.pauseForDecisionReview(sessionId, '正在等待受影响 Agent 完成当前工作并参与 DRI 决策复核')
    // Drain existing causal Agent work and its memory updates before asking for review.
    for (let round = 0; round < 32; round++) {
      const history = ctx.eventLog.listBySession(sessionId)
      const chain = [target, ...collectAgentDescendants(history, target.id)]
      if (typeof ctx.agentRuntime.waitForSource === 'function') {
        await Promise.all(chain.map((event) => ctx.agentRuntime.waitForSource(event.id)))
      }
      const throughSeq = Math.max(...ctx.eventLog.listBySession(sessionId).map((event) => event.seq))
      const agents = ctx.session.listMembers(sessionId, true).flatMap((member) => {
        try { ctx.agents.get(member.principalId); return [member.principalId] } catch { return [] }
      })
      await Promise.all(agents.map((agentId) => ctx.agentInbox.waitThrough(agentId, sessionId, throughSeq)))
      const after = ctx.eventLog.listBySession(sessionId)
      const next = [target, ...collectAgentDescendants(after, target.id)]
      if (next.every((event) => chain.some((prior) => prior.id === event.id)) &&
        Math.max(...after.map((event) => event.seq)) === throughSeq) break
      if (round === 31) throw new Error('等待受影响 Agent 完成时会话持续变化，请稍后重试')
    }
    const history = ctx.eventLog.listBySession(sessionId)
    const causal = [target, ...collectAgentDescendants(history, target.id)]
    const recipients = [...new Set(causal.flatMap((event) => {
      if (event.authorKind !== 'agent' || !event.authorId) return []
      try { ctx.agents.get(event.authorId); return [event.authorId] } catch { return [] }
    }))]
    request = ctx.eventLog.append({
      id: randomUUID(), sessionId, authorId, phaseId: null,
      authorKind: 'human', kind: 'decision',
      text: `${DECISION_REVIEW_REQUEST_MARKER}\n拟决策：${action}\n目标事件：${target.id}${reason ? `\n说明：${reason}` : ''}`,
      mentions: recipients, toolCalls: [], replyMode: '', replyTo: target.id,
    })
  }
  ctx.orchestrator.pauseForDecisionReview(sessionId, '受影响 Agent 已收到复核请求；等待 DRI 最终定案')
  if (reviewComplete(ctx, request)) {
    const questions = ctx.eventLog.listBySession(sessionId).filter((event) =>
      event.authorKind === 'agent' && event.text.startsWith(AGENT_REVIEW_QUESTION_MARKER) &&
      event.sourceEventId === request!.id).length
    return { request, questions }
  }
  const questions = await waitForReview(ctx, target, request)
  return { request, questions }
}

export function apply(ctx: Context) {
  ctx.commands.register({
    name: 'decision',
    usage: '/decision <pass|reject|modify|defer|recall|redo> <event-id> [原因或新要求] —— DRI 决策 Agent 回答',
    minArgs: 2,
    maxArgs: -1,
    async run(c) {
      const [actionRaw, targetId, ...reasonParts] = c.args
      if (!['pass', 'reject', 'modify', 'defer', 'recall', 'redo'].includes(actionRaw!)) {
        return { text: '用法：/decision <pass|reject|modify|defer|recall|redo> <event-id> [原因或新要求]' }
      }
      const action = actionRaw as Action
      const member = ctx.session.listMembers(c.sessionId, true)
        .find((candidate) => candidate.principalId === c.authorId)
      if (member?.role !== 'DRI') return { text: '只有本会话 DRI 可以执行该决策命令。' }

      const target = ctx.eventLog.listBySession(c.sessionId).find((event) => event.id === targetId)
      if (!target) return { text: '目标事件不存在或属于其他会话。' }
      const retryVoidedAnswer = target.voided && (action === 'redo' || action === 'modify')
      if (target.voided && !retryVoidedAnswer) return { text: '已撤回的回答只能定向重做或修改。' }
      if (target.authorKind !== 'agent' || target.kind !== 'message') {
        return { text: '决策命令只能作用于 Agent 的最终回答。' }
      }
      if (!target.authorId) return { text: '目标 Agent 身份缺失，不能安全地重做该回答。' }
      const reason = reasonParts.join(' ').trim()
      if (action !== 'pass' && !reason) return { text: `/${action} 必须填写原因或新要求。` }

      if (retryVoidedAnswer) {
        const decisionEvent = appendDecision(ctx, c.sessionId, c.authorId, target, action, reason)
        const requestText = action === 'modify'
          ? `请基于仍有效的会话信息重新处理这项已撤回工作，并遵循 DRI 的修改意见：${reason}`
          : `请重新执行这项已撤回工作，并遵循 DRI 的要求：${reason}`
        const request = ctx.eventLog.append({
          id: randomUUID(), sessionId: c.sessionId, authorId: c.authorId, phaseId: null,
          authorKind: 'human', kind: 'message', text: requestText,
          mentions: [target.authorId], toolCalls: [], replyMode: '', replyTo: target.id,
        })
        ctx.orchestrator.resolveDecisionReview(c.sessionId)
        resumeOrchestration(ctx, request, [target.authorId])
        return { text: `已把历史回答${action === 'modify' ? '修改后' : ''}定向交回原 Agent；决策记录：${decisionEvent.id}` }
      }

      if (action === 'defer') {
        const decisionEvent = appendDecision(ctx, c.sessionId, c.authorId, target, action, reason)
        try {
          const review = await startReview(ctx, c.sessionId, c.authorId, target, action, reason)
          return { text: `已暂缓并发起复核，相关 Agent 已处理完成（${review.questions} 个问题）；阅读后可再次决策。记录：${decisionEvent.id}` }
        } catch (error) { return { text: `已记录暂缓；复核尚未完成：${(error as Error).message}` } }
      }

      const activeReview = openReviewRequest(ctx, c.sessionId, target)
      if (!activeReview || !reviewComplete(ctx, activeReview)) {
        try {
          const review = await startReview(ctx, c.sessionId, c.authorId, target, action, reason)
          return { text: `复核已完成，${review.questions} 个 Agent 问题已显示在会话中。请阅读后再次从回复卡片提交决策。` }
        } catch (error) { return { text: `复核尚未完成，决策未执行：${(error as Error).message}` } }
      }

      if (action === 'pass') {
        const decisionEvent = appendDecision(ctx, c.sessionId, c.authorId, target, action, reason)
        ctx.orchestrator.resolveDecisionReview(c.sessionId)
        resumeOrchestration(ctx, decisionEvent)
        return { text: '已通过该 Agent 回答，决策已记入会话。' }
      }

      try {
        const decisionId = randomUUID()
        const impact = await withdraw(ctx, target, c.authorId, `dri_${action}: ${reason}; decision=${decisionId}`)
        const { invalidated, rebuilt } = impact
        const decisionEvent = appendDecision(ctx, c.sessionId, c.authorId, target, action, reason, decisionId)
        appendImpactRecord(ctx, decisionEvent, impact)
        ctx.orchestrator.resolveDecisionReview(c.sessionId)
        if (action === 'redo' || action === 'modify') {
          const requestText = action === 'modify'
            ? `请按 DRI 的修改意见修订回答，并保留仍然有效的内容：${reason}`
            : `请根据 DRI 的重做要求重新回答：${reason}`
          const replacement = ctx.eventLog.append({
            id: randomUUID(), sessionId: c.sessionId, authorId: c.authorId, phaseId: null,
            authorKind: 'human', kind: 'message', text: requestText,
            mentions: [target.authorId], toolCalls: [], replyMode: '', replyTo: target.id,
          })
          resumeOrchestration(ctx, replacement, [target.authorId])
          return { text: action === 'modify'
            ? `已撤回旧回答并按修改意见重新提交；${invalidated} 条来源记忆已失效，${rebuilt} 条混合来源记忆已重建。`
            : `已撤回旧回答并提交重做要求；${invalidated} 条来源记忆已失效，${rebuilt} 条混合来源记忆已重建。` }
        }
        if (action === 'reject') resumeOrchestration(ctx, decisionEvent)
        return { text: `已${action === 'reject' ? '否决' : '撤回'}该回答；${invalidated} 条来源记忆已失效，${rebuilt} 条混合来源记忆已重建。` }
      } catch (error) {
        return { text: `决策未完成：${(error as Error).message}` }
      }
    },
  })
}
