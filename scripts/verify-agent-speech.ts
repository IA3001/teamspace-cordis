// Agent speech is passive only after an explicit human @; proactive posts are one per passive reset.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { decideAgentSpeech } from 'space-agent-speech'
import type { SessionEvent } from 'space-event'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { MessageServiceImpl } from '../plugins/space-message/index.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'

const event = (id: string, seq: number, authorId: string | null, authorKind: SessionEvent['authorKind'],
  mentions: string[] = [], sourceEventId: string | null = null): SessionEvent => ({
  id, seq, sessionId: 'policy', phaseId: null, ts: new Date().toISOString(), authorId, authorKind,
  kind: 'message', text: id, mentions, toolCalls: [], replyMode: '', replyTo: null,
  sourceEventId, sourceEventIds: sourceEventId ? [sourceEventId] : [],
  voided: false, voidedBy: null, voidedAt: null, voidedReason: null,
})

const passiveTrigger = event('human-at', 1, 'u_human', 'human', ['a_speaker'])
const passiveReply = event('reply', 2, 'a_speaker', 'agent', [], passiveTrigger.id)
assert.deepEqual(decideAgentSpeech('a_speaker', 'proactive', null, []), { allowed: true, mode: 'proactive' })
assert.equal(decideAgentSpeech('a_speaker', 'proactive', null, [event('first', 1, 'a_speaker', 'agent')]).reason,
  'consecutive_proactive')
assert.deepEqual(decideAgentSpeech('a_speaker', 'passive', passiveTrigger.id, [passiveTrigger]), { allowed: true, mode: 'passive' })
assert.equal(decideAgentSpeech('a_speaker', 'passive', null, []).reason, 'proactive_disabled')
assert.deepEqual(decideAgentSpeech('a_speaker', 'proactive', null, [passiveTrigger, passiveReply]), { allowed: true, mode: 'proactive' },
  'a passive reply resets the next proactive allowance')

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrations = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrations)) db.exec(migration.up)
const ctx = new Context() as Context & Record<string, any>
new SqliteSessionStore(ctx, db)
const eventLog = new SqliteEventLog(ctx, db)
const at = new Date().toISOString()
db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
  VALUES ('u_human', 'human', '!', 'Human', 'human', ?, 'member')`).run(at)
db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at)
  VALUES ('a_speaker', 'a_speaker', '!', 'Speaker', 'agent', ?)`).run(at)
db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at)
  VALUES ('review_agent_v2', 'review_agent_v2', '!', 'Review Agent', 'agent', ?)`).run(at)
const snapshot = { descriptor: { id: 'a_speaker', title: 'Speaker', kind: 'custom', capabilities: [], speechPolicy: 'proactive' }, status: 'idle' }
const customSnapshot = { descriptor: { id: 'review_agent_v2', title: 'Review Agent', kind: 'custom', capabilities: [], speechPolicy: 'proactive' }, status: 'idle' }
Object.assign(ctx, {
  agents: {
    get(id: string) {
      if (id === 'a_speaker') return snapshot
      if (id === 'review_agent_v2') return customSnapshot
      throw new Error('not found')
    },
    list() { return [snapshot, customSnapshot] },
  },
})
new MessageServiceImpl(ctx)
const engine = new OrchestratorEngine(ctx)

async function main() {
  const session = ctx.session.createSession({ id: 's_speech', title: '发言限制验收' })
  ctx.session.join({ sessionId: session.id, principalId: 'u_human', role: '成员' })
  ctx.session.join({ sessionId: session.id, principalId: 'a_speaker', role: '成员', duty: 'Speaker' })

  await assert.rejects(
    ctx.messages.send(session.id, 'review_agent_v2', '未获邀请的 Agent 不得发言'),
    (error: unknown) => error instanceof Error && error.message.includes('不是会话') && error.message.includes('在册成员'),
    'registered Agents must be invited into the session before sending messages',
  )
  ctx.session.join({ sessionId: session.id, principalId: 'review_agent_v2', role: '成员', duty: 'Review Agent' })
  const customIdMessage = await ctx.messages.send(session.id, 'review_agent_v2', '使用自定义 ID 的 Agent 发言')
  assert.equal(customIdMessage.authorKind, 'agent', 'registered Agent IDs do not require a built-in prefix')

  const mention = eventLog.append({ id: 'trigger-1', sessionId: session.id, authorId: 'u_human', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@Speaker 请发言', mentions: ['a_speaker'], toolCalls: [], replyMode: '' })
  engine.beginExternalDelegate(session.id, mention.id, 'Speaker', '回复被 @ 的任务')
  const passive = engine.reportAgentResult(session.id, 'Speaker', '被动回复')
  assert.equal(passive.authorKind, 'agent', 'an explicit @ reply is allowed')

  for (const id of ['trigger-2', 'trigger-3']) {
    const trigger = eventLog.append({ id, sessionId: session.id, authorId: 'u_human', phaseId: null,
      authorKind: 'human', kind: 'message', text: '继续处理', mentions: [], toolCalls: [], replyMode: '' })
    engine.beginExternalDelegate(session.id, trigger.id, 'Speaker', '后台委托')
    const result = engine.reportAgentResult(session.id, 'Speaker', `处理结果 ${id}`)
    if (id === 'trigger-2') assert.equal(result.authorKind, 'agent', 'one proactive reply is allowed after passive speech')
    else {
      assert.equal(result.authorKind, 'system', 'the next proactive reply is intercepted')
      assert.match(result.text, /Speaker：尝试主动发言，但是被拦截/)
    }
  }

  const mentionAgain = eventLog.append({ id: 'trigger-reset', sessionId: session.id, authorId: 'u_human', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@Speaker 再回答一次', mentions: ['a_speaker'], toolCalls: [], replyMode: '' })
  engine.beginExternalDelegate(session.id, mentionAgain.id, 'Speaker', '被动重置')
  assert.equal(engine.reportAgentResult(session.id, 'Speaker', '重置后的被动回复').authorKind, 'agent')

  const directSession = ctx.session.createSession({ id: 's_direct', title: '统一消息入口验收' })
  ctx.session.join({ sessionId: directSession.id, principalId: 'u_human', role: '成员' })
  ctx.session.join({ sessionId: directSession.id, principalId: 'a_speaker', role: '成员' })
  const directTrigger = eventLog.append({ id: 'direct-at', sessionId: directSession.id, authorId: 'u_human', phaseId: null,
    authorKind: 'human', kind: 'message', text: '@Speaker', mentions: ['a_speaker'], toolCalls: [], replyMode: '' })
  const direct = await ctx.messages.send(directSession.id, 'a_speaker', '直接被动回复', [], undefined,
    { sourceEventId: directTrigger.id })
  assert.equal(direct.authorKind, 'agent', 'the shared message service accepts an explicitly sourced passive reply')
  const allowedProactive = await ctx.messages.send(directSession.id, 'a_speaker', '第一次主动发言')
  assert.equal(allowedProactive.authorKind, 'agent')
  const blocked = await ctx.messages.send(directSession.id, 'a_speaker', '第二次主动发言')
  assert.equal(blocked.authorKind, 'system')
  assert.match(blocked.text, /连续主动发言限制/)
  console.log('✓ Explicit @ replies reset per-Agent proactive allowance; consecutive and policy-disabled speech is visibly intercepted')
}

try { await main() } finally { db.close() }
