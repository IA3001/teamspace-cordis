import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { AgentInbox } from '../plugins/agent-inbox/index.ts'
import { SessionWork } from '../plugins/session-work/index.ts'
import { waitForMentionedAgentHistory } from '../plugins/orchestrator/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { AGENT_HISTORY_BOOTSTRAP_MARKER, DECISION_REVIEW_REQUEST_MARKER } from '../packages/seam/space-event/src/index.ts'

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

  for (const agentId of ['a_alpha', 'a_beta']) {
    assert.equal(await inbox.cursor(agentId, 's_alpha'), first.seq)
    assert.equal(await inbox.cursor(agentId, 's_beta'), second.seq)
    const recalled = await memory.recall(`agent:${agentId}`, { kind: 'conversation_fact:0' })
    assert.equal(recalled.length, 2, 'each Agent keeps its own memories across sessions')
    assert.deepEqual(new Set(recalled.map((item) => item.sourceEventId)), new Set([first.id, second.id]))
  }
  assert.equal(await inbox.cursor('a_gamma', 's_alpha'), first.seq,
    'memoryPolicy=none still advances the durable inbox cursor')
  assert.equal(await inbox.cursor('a_gamma', 's_beta'), second.seq,
    'memoryPolicy=none does not stall history synchronization across queued sessions')
  assert.equal((await memory.recall('agent:a_gamma')).length, 2,
    'memoryPolicy=none retains only the two system cursor rows and writes no semantic memory')

  assert.equal(await memory.forgetBySource(first.id), 2, 'source withdrawal invalidates derived memories for both Agents')
  assert.equal((await memory.recall('agent:a_alpha', { kind: 'conversation_fact:0' })).length, 1)
  assert.equal(ctx.eventLog.listBySession('s_alpha').length, 1, 'private processing does not create chat or trace events')

  // A newly invited Agent receives one dedicated, ordered history analysis before
  // its inbox cursor reaches the invitation event or a later @ reply can proceed.
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
  let onboardingSystem = ''
  const onboardingPayloads: Array<Record<string, any>> = []
  ctx.llm.chat = async (messages: Array<{ role: string; content: string }>) => {
    onboardingSystem = messages[0]!.content
    const payload = JSON.parse(messages[1]!.content) as Record<string, any>
    onboardingPayloads.push(payload)
    return JSON.stringify({ memories: [{
      text: payload.batch === 1 ? '历史批次一已整理' : '发布窗口为周六，DRI 负责验收', weight: 0.95,
    }] })
  }
  const invitation = ctx.eventLog.append({
    id: 'onboarding_invitation', sessionId: onboardingSession, authorId: null, phaseId: null,
    authorKind: 'system', kind: 'system', text: `${AGENT_HISTORY_BOOTSTRAP_MARKER} 邀请研究员加入。`,
    mentions: ['a_alpha'], toolCalls: [], replyMode: '',
  })
  await inbox.waitThrough('a_alpha', onboardingSession, invitation.seq)
  assert.match(onboardingSystem, /刚加入会话.*完整会话/u, 'invited Agents receive a dedicated whole-history onboarding prompt')
  assert.equal(onboardingPayloads.length, 2, 'long histories are split into bounded sequential batches')
  assert.deepEqual(onboardingPayloads.flatMap((payload) => payload.history.map((event: { id: string }) => event.id)),
    onboardingHistory.map((event) => event.id), 'onboarding analyzes the complete prior message history in sequence')
  assert.equal(onboardingPayloads[0]!.history[0].text.includes('onboarding-secret-value'), false,
    'onboarding redacts credentials before model input')
  assert.equal(onboardingPayloads[0]!.history[0].text.includes('[REDACTED]'), true)
  assert.deepEqual(onboardingPayloads[1]!.priorMemory, ['历史批次一已整理'],
    'later batches receive earlier synthesized memory for cross-batch context')
  assert.equal(await inbox.cursor('a_alpha', onboardingSession), invitation.seq,
    'the invitation cursor advances only after the onboarding analysis is persisted')
  const onboardingMemories = (await memory.recall('agent:a_alpha', { limit: 100 }))
    .filter((item) => item.kind.startsWith(`history_bootstrap:${onboardingSession}:`))
  assert.equal(onboardingMemories.length, 2, 'each history batch persists a private synthesized memory')
  assert.equal(onboardingMemories.some((item) => item.text.includes('发布窗口为周六')), true)
  assert.deepEqual(new Set(onboardingMemories.flatMap((item) => item.sourceEventIds)),
    new Set(onboardingHistory.map((event) => event.id)), 'onboarding memories remain traceable to all historical messages')
  assert.equal(ctx.eventLog.listBySession(onboardingSession).length, 23,
    'private onboarding does not emit additional chat or process events')

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
  assert.equal(await inbox.cursor('a_alpha', 's_review'), reviewTarget.seq,
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
  assert.equal(await recoveredInbox.cursor('a_recovery', 's_recovery'), recoveryEvent.seq,
    'startup recovery consumes committed events beyond the persisted Agent cursor')
  assert.equal(recoveryCalls, 1, 'recovery processes the missed event exactly once')
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
  assert.equal(await recoveredInbox.cursor('a_recovery', 's_recovery'), recoveryEvent.seq,
    'a failed extraction does not advance the durable cursor')
  const retryWaitAfterFailure = recoveredInbox.waitThrough('a_recovery', 's_recovery', retryEvent.seq)
  await Promise.race([
    retryWaitAfterFailure,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inbox retry timed out')), 5_000)),
  ])
  assert.equal(retryCalls, 2, 'the failed event is retried after a temporary model outage')
  assert.equal(await recoveredInbox.cursor('a_recovery', 's_recovery'), retryEvent.seq,
    'the cursor advances only after the retry succeeds')
  assert.equal((await recoveryMemory.recall('agent:a_recovery', { kind: 'conversation_fact:0' }))
    .some((item) => item.sourceEventId === retryEvent.id), true,
  'retry persists the memory with its source event')
  recoveryDb.close()
  console.log('✓ Agent inbox ordering, retries, per-Agent isolation, durable cursors, source provenance, and session serialization passed')
  db.close()
}

await main()
