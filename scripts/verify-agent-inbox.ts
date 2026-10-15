import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { AgentInbox } from '../plugins/agent-inbox/index.ts'
import { MessageServiceImpl } from '../plugins/space-message/index.ts'
import { SessionWork } from '../plugins/session-work/index.ts'
import { waitForMentionedAgentHistory } from '../plugins/orchestrator/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { AGENT_HISTORY_BOOTSTRAP_MARKER, DECISION_REVIEW_REQUEST_MARKER, isAgentVisibleEvent } from '../packages/seam/space-event/src/index.ts'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrations = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrations)) db.exec(migration.up)

const ctx = new Context() as Context & Record<string, any>
new SqliteSessionStore(ctx, db)
new SqliteEventLog(ctx, db)
const memory = new SqliteMemoryStore(ctx, db)
new SessionWork(ctx)
const agents = new AgentRegistry(ctx)
agents.register({ id: 'a_alpha', kind: 'coding', title: '研究员', capabilities: [], description: '提取可复用知识' })
agents.register({ id: 'a_beta', kind: 'coding', title: '记录员', capabilities: [], description: '记录明确决策' })
agents.register({ id: 'a_gamma', kind: 'custom', title: '无记忆助手', capabilities: [], memoryPolicy: 'none' })

let started = 0
const startedSessions: string[] = []
const modelInputs: string[] = []
const release: Array<() => void> = []
Object.assign(ctx, {
  llm: {
    configured: true,
    configuredFor: () => true,
    async chat(messages: Array<{ role: string; content: string }>) {
      modelInputs.push(messages[1]!.content)
      const input = JSON.parse(messages[1]!.content) as { sessionId: string; event: { id: string } }
      started++
      startedSessions.push(input.sessionId)
      await new Promise<void>((resolve) => release.push(resolve))
      return JSON.stringify({ memories: [{ text: `持久信息来自 ${input.event.id}`, weight: 0.9 }] })
    },
  },
})
const inbox = new AgentInbox(ctx)

function createSession(id: string): void {
  const insertUser = db.prepare(`INSERT OR IGNORE INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, ?, ?, 'member')`)
  insertUser.run('u_member', 'inbox_member', 'Inbox Member', 'human', new Date().toISOString())
  insertUser.run('a_alpha', 'inbox_alpha', '研究员', 'agent', new Date().toISOString())
  insertUser.run('a_beta', 'inbox_beta', '记录员', 'agent', new Date().toISOString())
  insertUser.run('a_gamma', 'inbox_gamma', '无记忆助手', 'agent', new Date().toISOString())
  ctx.session.createSession({ id, title: id })
  ctx.session.join({ sessionId: id, principalId: 'u_member', role: 'DRI' })
  ctx.session.join({ sessionId: id, principalId: 'a_alpha', role: '成员' })
  ctx.session.join({ sessionId: id, principalId: 'a_beta', role: '成员' })
  ctx.session.join({ sessionId: id, principalId: 'a_gamma', role: '成员' })
}

function append(sessionId: string, text: string) {
  return ctx.eventLog.append({
    id: `${sessionId}_event`, sessionId, authorId: 'u_member', phaseId: null,
    authorKind: 'human', kind: 'message', text, mentions: [], toolCalls: [], replyMode: '',
  })
}

async function main(): Promise<void> {
  createSession('s_alpha')
  createSession('s_beta')
  const first = append('s_alpha', '我们已确认发布窗口为周五。 api_key=secret-value-123')
  const second = append('s_beta', '这是另一会话的内容。')

  const waits = [
    inbox.waitThrough('a_alpha', 's_alpha', first.seq),
    inbox.waitThrough('a_beta', 's_alpha', first.seq),
    inbox.waitThrough('a_gamma', 's_alpha', first.seq),
    inbox.waitThrough('a_alpha', 's_beta', second.seq),
    inbox.waitThrough('a_beta', 's_beta', second.seq),
    inbox.waitThrough('a_gamma', 's_beta', second.seq),
  ]
  for (let i = 0; i < 50 && started < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(started, 2, 'Agents in the active session process in parallel')
  assert.equal(inbox.processing().filter((item) => item.sessionId === 's_alpha' && item.phase === 'extracting-memory').length, 2,
    'live inbox state identifies each Agent currently extracting message memory')
  assert.equal(inbox.activeSessionId(), 's_alpha')
  assert.equal(ctx.sessionWork.state().activeSessionId, 's_alpha', 'Agent Inbox holds the shared active-session slot')
  assert.equal(ctx.sessionWork.tryEnter('s_beta', 'orchestrator:s_beta'), false,
    'the orchestrator cannot start a different session while Inbox work owns the slot')
  assert.equal(ctx.sessionWork.tryEnter('s_alpha', 'orchestrator:s_alpha'), true,
    'orchestrator work may join the same active session')
  ctx.sessionWork.leave('s_alpha', 'orchestrator:s_alpha')
  assert(modelInputs.every((input) => !input.includes('secret-value-123') && input.includes('[REDACTED]')),
    'credential-like text is redacted before memory extraction')
  assert.deepEqual([...new Set(startedSessions)], ['s_alpha'], 'a second session waits behind the active session')
  assert.equal(await inbox.cursor('a_alpha', 's_beta'), 0, 'queued session cursor remains unchanged until the active session drains')

  let barrierPassed = false
  const barrier = waitForMentionedAgentHistory(ctx, 's_alpha', ['a_alpha'], first.seq)
    .then(() => { barrierPassed = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(barrierPassed, false, 'a mentioned Agent cannot reply before history extraction finishes')

  while (release.length) release.shift()!()
  for (let i = 0; i < 50 && started < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(started, 4, 'queued session starts after all Agents finish the active session')
  assert.equal(ctx.sessionWork.state().activeSessionId, 's_beta', 'the next Inbox session owns the shared slot')
  assert.equal(ctx.sessionWork.tryEnter('s_beta', 'orchestrator:s_beta'), true,
    'a queued orchestrator task can join once its session becomes active')
  ctx.sessionWork.leave('s_beta', 'orchestrator:s_beta')
  assert.deepEqual([...new Set(startedSessions)], ['s_alpha', 's_beta'])
  while (release.length) release.shift()!()
  await barrier
  assert.equal(barrierPassed, true, 'the mention barrier opens after the Agent memory cursor reaches the event')
  await Promise.all(waits)
  assert.equal(inbox.processing().some((item) => item.sessionId === 's_alpha' || item.sessionId === 's_beta'), false,
    'live inbox state clears after the durable cursor catches up')

  for (const agentId of ['a_alpha', 'a_beta']) {
    assert((await inbox.cursor(agentId, 's_alpha')) >= first.seq)
    assert((await inbox.cursor(agentId, 's_beta')) >= second.seq)
    const recalled = await memory.recall(`agent:${agentId}`, { kind: 'conversation_fact:0' })
    assert.equal(recalled.length, 2, 'each Agent keeps its own memories across sessions')
    assert.deepEqual(new Set(recalled.map((item) => item.sourceEventId)), new Set([first.id, second.id]))
  }
  assert((await inbox.cursor('a_gamma', 's_alpha')) >= first.seq,
    'memoryPolicy=none still advances the durable inbox cursor')
  assert((await inbox.cursor('a_gamma', 's_beta')) >= second.seq,
    'memoryPolicy=none does not stall history synchronization across queued sessions')
  assert.equal((await memory.recall('agent:a_gamma')).length, 2,
    'memoryPolicy=none retains only the two system cursor rows and writes no semantic memory')

  assert.equal(await memory.forgetBySource(first.id), 2, 'source withdrawal invalidates derived memories for both Agents')
  assert.equal((await memory.recall('agent:a_alpha', { kind: 'conversation_fact:0' })).length, 1)
  const alphaEvents = ctx.eventLog.listBySession('s_alpha')
  const alphaTrace = alphaEvents.find((event) => event.sourceEventId === first.id &&
    event.toolCalls.some((call) => call.name === 'agent.inbox.trace' && call.args.includes('a_alpha')))
  assert(alphaTrace, 'background processing persists a trace linked to its source message')
  assert.equal(isAgentVisibleEvent(alphaTrace), false, 'private inbox traces stay out of chat and Agent context')
  const traceData = JSON.parse(alphaTrace.toolCalls.find((call) => call.name === 'agent.inbox.trace')!.args)
  assert.equal(traceData.agentId, 'a_alpha', 'durable trace identifies the exact Agent by stable ID')
  assert.equal(traceData.agentTitle, '研究员', 'durable trace stores the Agent display name')
  assert(traceData.steps.some((step: { label: string }) => step.label === '长期记忆处理'),
    'trace explains which processing path ran')
  assert.equal(traceData.modelTrace.length, 1, 'the history trace persists every background LLM request')
  assert.equal(traceData.modelTrace[0].request[0].source, '长期记忆提取系统提示词')
  assert.equal(traceData.modelTrace[0].request[1].source, `待处理会话消息 #${first.seq} · ${first.id}`)
  assert.equal(traceData.modelTrace[0].status, 'completed')
  assert.match(traceData.modelTrace[0].response, /持久信息来自/u, 'the exact model completion is retained')
  assert(!JSON.stringify(traceData.modelTrace).includes('secret-value-123'), 'audit prompts keep credentials redacted')
  assert.equal(traceData.modelTrace.length, 1, 'the history trace persists every background LLM request')
  assert.equal(traceData.modelTrace[0].request[0].source, '长期记忆提取系统提示词')
  assert.equal(traceData.modelTrace[0].request[1].source, `待处理会话消息 #${first.seq} · ${first.id}`)
  assert.equal(traceData.modelTrace[0].status, 'completed')
  assert.match(traceData.modelTrace[0].response, /持久信息来自/u, 'the exact model completion is retained')
  assert(!JSON.stringify(traceData.modelTrace).includes('secret-value-123'), 'audit prompts keep credentials redacted')
  assert(alphaEvents.filter(isAgentVisibleEvent).length === 1, 'private processing does not add visible chat messages')

  const targeted = ctx.eventLog.append({
    id: 's_alpha_targeted', sessionId: 's_alpha', authorId: 'u_member', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@研究员 请给出结论', mentions: ['a_alpha'],
    toolCalls: [], replyMode: '',
  })
  const modelCallsBeforeTargeted = started
  await Promise.all(['a_alpha', 'a_beta'].map((id) => inbox.waitThrough(id, 's_alpha', targeted.seq)))
  assert.equal(started, modelCallsBeforeTargeted,
    'an explicitly addressed message skips per-Agent background memory calls; the requested task supplies its own context')

  // A newly invited Agent receives old messages through the same ordered inbox
  // queue as live events. The cursor cannot jump to the invitation while the
  // first older message is still being analyzed.
  const onboardingSession = 's_onboarding'
  ctx.session.createSession({ id: onboardingSession, title: '新 Agent 历史引导' })
  ctx.session.join({ sessionId: onboardingSession, principalId: 'u_member', role: 'DRI' })
  const onboardingHistory = Array.from({ length: 22 }, (_, index) =>
    index === 0 ? '已确认下周五发布。 api_key=onboarding-secret-value' :
      index === 21 ? '更正：发布窗口改为周六，DRI 负责验收。' : `历史讨论消息 ${index + 1}`,
  ).map((text, index) =>
    ctx.eventLog.append({
      id: `onboarding_history_${index}`, sessionId: onboardingSession, authorId: 'u_member', phaseId: null,
      authorKind: 'human', kind: 'message', text, mentions: [], toolCalls: [], replyMode: '',
    }))
  ctx.session.join({ sessionId: onboardingSession, principalId: 'a_alpha', role: '成员' })
  const onboardingPayloads: Array<Record<string, any>> = []
  let releaseFirstOnboarding!: () => void
  const firstOnboardingHeld = new Promise<void>((resolve) => { releaseFirstOnboarding = resolve })
  let finishOldDecision: (() => void) | undefined
  let oldDecisionStarted = false
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    const payload = JSON.parse(messages[1]!.content) as Record<string, any>
    onboardingPayloads.push(payload)
    if (onboardingPayloads.length === 1) await firstOnboardingHeld
    return JSON.stringify({ memories: [{ text: `按序处理 ${payload.event.id}`, weight: 0.95 }] })
  }
  const invitation = ctx.eventLog.append({
    id: 'onboarding_invitation', sessionId: onboardingSession, authorId: null, phaseId: null,
    authorKind: 'system', kind: 'system', text: `${AGENT_HISTORY_BOOTSTRAP_MARKER} 邀请研究员加入。`,
    mentions: ['a_alpha'], toolCalls: [], replyMode: '',
  })
  const onboardingWait = inbox.waitThrough('a_alpha', onboardingSession, invitation.seq)
  for (let i = 0; i < 50 && onboardingPayloads.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(onboardingPayloads.length, 1, 'history starts as a one-message-at-a-time queue')
  assert.equal(onboardingPayloads[0]!.event.id, onboardingHistory[0]!.id, 'the oldest event is processed first')
  assert.equal(await inbox.cursor('a_alpha', onboardingSession), 0, 'the cursor does not jump past the pending history')
  assert.equal(onboardingPayloads[0]!.event.text.includes('onboarding-secret-value'), false,
    'queued history redacts credentials before model input')
  assert.equal(onboardingPayloads[0]!.event.text.includes('[REDACTED]'), true)
  releaseFirstOnboarding()
  await onboardingWait
  assert.deepEqual(onboardingPayloads.map((payload) => payload.event.id),
    onboardingHistory.map((event) => event.id), 'all historical messages are consumed by the normal queue in sequence')
  assert((await inbox.cursor('a_alpha', onboardingSession)) >= invitation.seq,
    'the invitation cursor advances only after the onboarding analysis is persisted')
  const onboardingMemories = (await memory.recall('agent:a_alpha', { limit: 100 }))
    .filter((item) => item.sourceEventId && onboardingHistory.some((event) => event.id === item.sourceEventId))
  assert.equal(onboardingMemories.length, onboardingHistory.length,
    'each processed history message writes an individually traceable memory candidate')
  assert.deepEqual(new Set(onboardingMemories.map((item) => item.sourceEventId)),
    new Set(onboardingHistory.map((event) => event.id)), 'queued memories retain per-message provenance')
  assert.equal(ctx.eventLog.listBySession(onboardingSession).filter(isAgentVisibleEvent).length, 23,
    'private onboarding traces do not emit visible chat messages')

  const mixed = await memory.remember('agent:a_alpha', 'mixed_decision', '综合两个来源的记忆', {
    authorId: 'a_alpha', sourceEventIds: [first.id, second.id],
  })
  ctx.eventLog.void(first.id, 'u_member', '验证混合来源记忆重建')
  const invalidated = await memory.invalidateBySource(first.id)
  assert(invalidated.some((item) => item.id === mixed.id && item.sourceEventIds.includes(second.id)),
    'invalidation returns the immutable mixed-source snapshot for rebuilding')
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    const payload = JSON.parse(messages[1]!.content) as { survivingSources: Array<{ id: string }> }
    assert.deepEqual(payload.survivingSources.map((source) => source.id), [second.id],
      'rebuild prompt contains only sources that remain valid')
    return JSON.stringify({ memories: [{ text: '仅由仍有效来源支持的重建记忆', weight: 0.8 }] })
  }
  const rebuilt = await inbox.rebuildInvalidatedMemory(invalidated[0]!, [second])
  assert.equal(rebuilt, 1, 'memory extractor creates one rebuilt memory')
  const replacement = await memory.recall('agent:a_alpha', { kind: `mixed_decision:rebuilt:${mixed.id}:0` })
  assert.equal(replacement.length, 1)
  assert.deepEqual(replacement[0]!.sourceEventIds, [second.id],
    'rebuilt memory retains only surviving provenance')

  createSession('s_review')
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    if (messages[0]!.content.includes('协助 DRI 审议')) return JSON.stringify({ question: '这个下游决定是否已经通知其他成员？' })
    return JSON.stringify({ memories: [] })
  }
  const reviewTarget = ctx.eventLog.append({
    id: 's_review_target', sessionId: 's_review', authorId: 'a_alpha', phaseId: null,
    authorKind: 'agent', kind: 'message', text: '建议立即撤回旧配置。', mentions: [], toolCalls: [], replyMode: '',
  })
  const review = ctx.eventLog.append({
    id: 's_review_request', sessionId: 's_review', authorId: 'u_member', phaseId: null,
    authorKind: 'human', kind: 'decision',
    text: `${DECISION_REVIEW_REQUEST_MARKER}\n拟决策：reject\n目标事件：${reviewTarget.id}\n说明：需要确认影响范围`,
    mentions: ['a_alpha'], toolCalls: [], replyMode: '', replyTo: reviewTarget.id,
  })
  let reviewModelCalls = 0
  const remember = memory.remember.bind(memory)
  let failReviewCursorOnce = true
  memory.remember = async (scope, kind, text, opts) => {
    const questionExists = ctx.eventLog.listBySession('s_review').some((event) =>
      event.sourceEventId === review.id && event.text.startsWith('【复核疑问】'))
    if (failReviewCursorOnce && kind === 'cursor:s_review' && questionExists) {
      failReviewCursorOnce = false
      throw new Error('simulated crash after review question append')
    }
    return remember(scope, kind, text, opts)
  }
  const originalReviewChat = ctx.llm.chat
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    if (messages[0]!.content.includes('协助 DRI 审议')) reviewModelCalls++
    return originalReviewChat(messages)
  }
  await assert.rejects(inbox.waitThrough('a_alpha', 's_review', review.seq), /simulated crash after review question append/,
    'a cursor failure after publishing the review question leaves the request replayable')
  assert((await inbox.cursor('a_alpha', 's_review')) < review.seq,
    'a failed durable cursor write does not mark the review request consumed')
  const replayReview = inbox.waitThrough('a_alpha', 's_review', review.seq)
  await Promise.race([
    replayReview,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('review request replay timed out')), 5_000)),
  ])
  const question = ctx.eventLog.listBySession('s_review').find((event) => event.sourceEventId === review.id)
  assert(question && question.authorId === 'a_alpha' && question.replyTo === reviewTarget.id,
    'the invited Agent can publish an auditable question linked to the target answer')
  assert.match(question.text, /^【复核疑问】/)
  assert.equal(ctx.eventLog.listBySession('s_review').filter((event) =>
    event.sourceEventId === review.id && event.text.startsWith('【复核疑问】')).length, 1,
  'replaying the review request after a cursor failure does not append a duplicate question')
  assert.equal(reviewModelCalls, 1, 'the already-persisted review question avoids a duplicate model call')
  await Promise.all(['a_alpha', 'a_beta', 'a_gamma'].map((id) => inbox.waitThrough(id, 's_review', question.seq)))
  assert.equal((await memory.recall('agent:a_alpha')).some((item) => item.sourceEventId === question.id), false,
    'review questions are not converted into Agent memory or normal answers')

  // Proactive Agents evaluate each live, non-addressed message once, while the
  // speech policy suppresses consecutive proactive replies and stores a timeline hint.
  agents.register({
    id: 'a_proactive', kind: 'custom', title: '主动发言测试 Agent', capabilities: [],
    speechPolicy: 'proactive', memoryPolicy: 'none',
  })
  db.prepare(`INSERT OR IGNORE INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, 'agent', ?, 'member')`).run('a_proactive', 'inbox_proactive', '主动发言测试 Agent', new Date().toISOString())
  ctx.session.createSession({ id: 's_proactive', title: '主动发言验收' })
  ctx.session.join({ sessionId: 's_proactive', principalId: 'u_member', role: 'DRI' })
  ctx.session.join({ sessionId: 's_proactive', principalId: 'a_proactive', role: '成员' })
  ctx.context = {
    async assemble(sessionId: string) {
      return { sessionId, system: '这是该 Agent 的专属上下文', history: ctx.eventLog.listBySession(sessionId), memories: [], retrieval: [], approxChars: 1 }
    },
  }
  new MessageServiceImpl(ctx)
  let proactiveModelCalls = 0
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    proactiveModelCalls++
    assert.match(messages[0]!.content, /专属上下文/u, 'proactive decisions receive assembled Agent context')
    const input = JSON.parse(messages[1]!.content) as { trigger: { text: string } }
    if (input.trigger.text === '较旧判断等待模型') {
      oldDecisionStarted = true
      await new Promise<void>((resolve) => { finishOldDecision = resolve })
      return JSON.stringify({ memories: [], decision: 'speak', text: '已经过期的主动答复' })
    }
    if (input.trigger.text === '第一次触发') return JSON.stringify({ memories: [], decision: 'speak', text: '我补充一个有用观点。' })
    if (input.trigger.text === '连续触发') return JSON.stringify({ memories: [], decision: 'speak', text: '我还想接着补充。' })
    if (input.trigger.text === '被@后恢复') return JSON.stringify({ memories: [], decision: 'speak', text: '被@回应后可以重新主动补充。' })
    return JSON.stringify({ memories: [], decision: 'pass', text: '' })
  }
  const proactiveFirst = await ctx.messages.send('s_proactive', 'u_member', '第一次触发')
  await inbox.waitThrough('a_proactive', 's_proactive', proactiveFirst.seq)
  const firstSpeech = ctx.eventLog.listBySession('s_proactive').find((event) =>
    event.authorId === 'a_proactive' && event.sourceEventId === proactiveFirst.id)
  assert.equal(firstSpeech?.text, '我补充一个有用观点。', 'a proactive Agent speaks after a live message without an @ mention')

  const proactiveSecond = await ctx.messages.send('s_proactive', 'u_member', '连续触发')
  await inbox.waitThrough('a_proactive', 's_proactive', proactiveSecond.seq)
  const persistentHint = ctx.eventLog.listBySession('s_proactive').find((event) =>
    event.authorId === 'a_proactive' && event.sourceEventId === proactiveSecond.id && event.kind === 'system')
  assert.equal(persistentHint?.text.startsWith('有话想说：'), true,
    'a suppressed proactive reply becomes a durable Agent timeline event')
  assert.equal(persistentHint?.sourceEventIds.includes(proactiveSecond.id), true,
    'the durable hint retains its triggering message as provenance')

  const beforeDirectedMention = proactiveModelCalls
  const directedToOther = ctx.eventLog.append({
    id: 's_proactive_directed_to_other', sessionId: 's_proactive', authorId: 'u_member', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@研究员 这条请你处理', mentions: ['a_alpha'], toolCalls: [], replyMode: '',
  })
  await inbox.waitThrough('a_proactive', 's_proactive', directedToOther.seq)
  assert.equal(proactiveModelCalls, beforeDirectedMention,
    'a proactive Agent does not spend a model call judging a message explicitly addressed to another Agent')
  assert.equal(ctx.eventLog.listBySession('s_proactive').some((event) =>
    event.authorId === 'a_proactive' && event.sourceEventId === directedToOther.id), false,
  'a non-mentioned proactive Agent stays silent on another Agent’s directed message')

  const oldTrigger = await ctx.messages.send('s_proactive', 'u_member', '较旧判断等待模型')
  const oldWait = inbox.waitThrough('a_proactive', 's_proactive', oldTrigger.seq)
  for (let i = 0; i < 50 && !oldDecisionStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert(oldDecisionStarted, 'the old proactive model call has started before the explicit @ arrives')
  const supersedingMention = await ctx.messages.send('s_proactive', 'u_member', '@主动发言测试 Agent 请直接回答', ['a_proactive'])
  finishOldDecision!()
  await oldWait
  await inbox.waitThrough('a_proactive', 's_proactive', supersedingMention.seq)
  assert(!ctx.eventLog.listBySession('s_proactive').some((item) => item.authorId === 'a_proactive' && item.sourceEventId === oldTrigger.id),
    'a newer explicit @ suppresses both the old proactive answer and its misleading @-me hint')

  const addressed = await ctx.messages.send('s_proactive', 'u_member', '@主动发言测试 Agent 请继续', ['a_proactive'])
  await inbox.waitThrough('a_proactive', 's_proactive', addressed.seq)
  const passiveReply = await ctx.messages.send('s_proactive', 'a_proactive', '收到，继续补充。', [], null, { sourceEventId: addressed.id })
  assert.equal(passiveReply.authorId, 'a_proactive', 'a direct human @ reply remains allowed and resets proactive eligibility')
  const afterAddressed = await ctx.messages.send('s_proactive', 'u_member', '被@后恢复')
  await inbox.waitThrough('a_proactive', 's_proactive', afterAddressed.seq)
  assert.equal(ctx.eventLog.listBySession('s_proactive').some((event) =>
    event.authorId === 'a_proactive' && event.sourceEventId === afterAddressed.id), true,
  'an @-triggered reply restores the Agent\'s ability to speak proactively on later messages')

  // Simulate an app restart with a committed message that arrived before the new
  // AgentInbox subscribed to event notifications. Boot recovery must replay it.
  const recoveryDb = new DatabaseSync(':memory:')
  recoveryDb.exec('PRAGMA foreign_keys = ON')
  for (const migration of loadMigrations(migrations)) recoveryDb.exec(migration.up)
  const recoveryCtx = new Context() as Context & Record<string, any>
  new SqliteSessionStore(recoveryCtx, recoveryDb)
  const recoveryLog = new SqliteEventLog(recoveryCtx, recoveryDb)
  const recoveryMemory = new SqliteMemoryStore(recoveryCtx, recoveryDb)
  new SessionWork(recoveryCtx)
  const recoveryAgents = new AgentRegistry(recoveryCtx)
  recoveryAgents.register({ id: 'a_recovery', kind: 'custom', title: '恢复验收 Agent', capabilities: [] })
  recoveryDb.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, ?, ?, 'member')`).run('u_recovery', 'recovery_user', 'Recovery User', 'human', new Date().toISOString())
  recoveryDb.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
    VALUES (?, ?, 'test', ?, ?, ?, 'member')`).run('a_recovery', 'recovery_agent', '恢复验收 Agent', 'agent', new Date().toISOString())
  recoveryCtx.session.createSession({ id: 's_recovery', title: '恢复验收' })
  recoveryCtx.session.join({ sessionId: 's_recovery', principalId: 'u_recovery', role: 'DRI' })
  recoveryCtx.session.join({ sessionId: 's_recovery', principalId: 'a_recovery', role: '成员' })
  const recoveryEvent = recoveryLog.append({
    id: 'recovery_history', sessionId: 's_recovery', authorId: 'u_recovery', phaseId: null,
    authorKind: 'human', kind: 'message', text: '进程停止期间提交的历史消息。', mentions: [], toolCalls: [], replyMode: '',
  })
  // A completed meeting can also contain unconsumed events (for example, if the
  // process stopped while it was open). Boot recovery must leave it as history.
  recoveryCtx.session.createSession({ id: 's_closed_recovery', title: '已结束会议' })
  recoveryCtx.session.join({ sessionId: 's_closed_recovery', principalId: 'u_recovery', role: 'DRI' })
  recoveryCtx.session.join({ sessionId: 's_closed_recovery', principalId: 'a_recovery', role: '成员' })
  const closedRecoveryEvent = recoveryLog.append({
    id: 'closed_recovery_history', sessionId: 's_closed_recovery', authorId: 'u_recovery', phaseId: null,
    authorKind: 'human', kind: 'message', text: '已结束会议中的历史消息不应重新处理。', mentions: [], toolCalls: [], replyMode: '',
  })
  recoveryCtx.session.closeSession('s_closed_recovery')
  let recoveryCalls = 0
  Object.assign(recoveryCtx, { llm: {
    configured: true,
    configuredFor: () => true,
    async chat() { recoveryCalls++; return JSON.stringify({ memories: [{ text: '重启后追赶的持久记忆', weight: 0.9 }] }) },
  } })
  const recoveredInbox = new AgentInbox(recoveryCtx)
  for (let i = 0; i < 100 && await recoveredInbox.cursor('a_recovery', 's_recovery') < recoveryEvent.seq; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert((await recoveredInbox.cursor('a_recovery', 's_recovery')) >= recoveryEvent.seq,
    'startup recovery consumes committed events beyond the persisted Agent cursor')
  assert.equal(recoveryCalls, 1, 'recovery processes the missed event exactly once')
  assert.equal(await recoveredInbox.cursor('a_recovery', 's_closed_recovery'), 0,
    'startup recovery does not replay events from a closed meeting')
  assert.equal(recoveryCalls, 1, 'closed meeting history does not trigger additional model calls')
  assert.equal(recoveryLog.listBySession('s_closed_recovery').some((event) => event.id !== closedRecoveryEvent.id), false,
    'closed meeting recovery does not append new inbox traces')
  await recoveredInbox.waitThrough('a_recovery', 's_closed_recovery', closedRecoveryEvent.seq)
  assert.equal(await recoveredInbox.cursor('a_recovery', 's_closed_recovery'), 0,
    'a late explicit inbox barrier cannot restart processing after a meeting closes')
  const recoveredMemories = await recoveryMemory.recall('agent:a_recovery', { kind: 'conversation_fact:0' })
  assert.deepEqual(recoveredMemories[0]?.sourceEventIds, [recoveryEvent.id], 'recovered memory preserves event provenance')

  let retryCalls = 0
  Object.assign(recoveryCtx.llm, { async chat() {
    retryCalls++
    if (retryCalls === 1) throw new Error('temporary model outage')
    return JSON.stringify({ memories: [{ text: '故障恢复后补写的记忆', weight: 0.9 }] })
  } })
  const retryEvent = recoveryLog.append({
    id: 'recovery_retry_history', sessionId: 's_recovery', authorId: 'u_recovery', phaseId: null,
    authorKind: 'human', kind: 'message', text: '模型短暂不可用时也不能丢失这条记忆。',
    mentions: [], toolCalls: [], replyMode: '',
  })
  const retryWait = recoveredInbox.waitThrough('a_recovery', 's_recovery', retryEvent.seq)
  await assert.rejects(retryWait, /temporary model outage/,
    'a failed memory update releases the explicit reply barrier promptly with a retryable error')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert((await recoveredInbox.cursor('a_recovery', 's_recovery')) < retryEvent.seq,
    'a failed extraction does not advance the durable cursor')
  const retryWaitAfterFailure = recoveredInbox.waitThrough('a_recovery', 's_recovery', retryEvent.seq)
  await Promise.race([
    retryWaitAfterFailure,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inbox retry timed out')), 5_000)),
  ])
  assert.equal(retryCalls, 2, 'the failed event is retried after a temporary model outage')
  assert((await recoveredInbox.cursor('a_recovery', 's_recovery')) >= retryEvent.seq,
    'the cursor advances only after the retry succeeds')
  assert.equal((await recoveryMemory.recall('agent:a_recovery', { kind: 'conversation_fact:0' }))
    .some((item) => item.sourceEventId === retryEvent.id), true,
  'retry persists the memory with its source event')

  let permanentCalls = 0
  Object.assign(recoveryCtx.llm, { async chat() {
    permanentCalls++
    throw new Error('LLM 返回 404（单次不重试）：UnsupportedModel')
  } })
  const permanentEvent = recoveryLog.append({
    id: 'recovery_permanent_failure', sessionId: 's_recovery', authorId: 'u_recovery', phaseId: null,
    authorKind: 'human', kind: 'message', text: '不支持的模型不应被持续重试。',
    mentions: [], toolCalls: [], replyMode: '',
  })
  await assert.rejects(recoveredInbox.waitThrough('a_recovery', 's_recovery', permanentEvent.seq), /UnsupportedModel/)
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.equal(permanentCalls, 1, 'permanent provider rejections do not retry on a timer')
  assert((await recoveredInbox.cursor('a_recovery', 's_recovery')) < permanentEvent.seq,
    'a permanently rejected event remains pending for a deliberate later retry')
  recoveryDb.close()
  console.log('✓ Agent inbox ordering, retries, per-Agent isolation, durable cursors, source provenance, and session serialization passed')
  db.close()
}

await main()
