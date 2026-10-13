import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { CommandService } from '../packages/seam/space-command/src/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import type { SessionEvent } from '../packages/seam/space-event/src/index.ts'
import { apply as applyDecisionCommands } from '../plugins/decision-commands/index.ts'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrations = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrations)) db.exec(migration.up)

const ctx = new Context() as Context & Record<string, any>
new SqliteSessionStore(ctx, db)
const eventLog = new SqliteEventLog(ctx, db)
const memory = new SqliteMemoryStore(ctx, db)
new CommandService(ctx)
let duringInboxWait: (() => Promise<void>) | null = null
const rebuildCalls: Array<{ itemId: string; sourceIds: string[] }> = []
const cancelledSources: string[] = []
Object.assign(ctx, {
  agents: { get: (id: string) => ({ descriptor: { id } }) },
  agentRuntime: {
    cancelBySource: async (sourceId: string) => { cancelledSources.push(sourceId); return 0 },
    waitForSource: async () => undefined,
  },
  orchestrator: {
    cancelDelegationsBySource: (_sessionId: string, sourceId: string) => { cancelledSources.push(sourceId); return [] },
    pauseForDecisionReview: () => undefined,
    resolveDecisionReview: () => undefined,
  },
  agentInbox: { waitThrough: async () => {
    const callback = duringInboxWait
    if (callback) {
      duringInboxWait = null
      await callback()
    }
  }, rebuildInvalidatedMemory: async (item: { id: string }, sources: SessionEvent[]) => {
    rebuildCalls.push({ itemId: item.id, sourceIds: sources.map((event) => event.id) })
    return 1
  } },
})
ctx.session.createSession({ id: 's_decisions', title: '决策验收' })
const insertPrincipal = db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
  VALUES (?, ?, '!', ?, ?, ?, 'member')`)
insertPrincipal.run('u_dec_dri', 'decision_dri', 'DRI', 'human', new Date().toISOString())
insertPrincipal.run('u_dec_member', 'decision_member', 'Member', 'human', new Date().toISOString())
insertPrincipal.run('a_dec_writer', 'a_writer', 'Writer', 'agent', new Date().toISOString())
insertPrincipal.run('a_dec_follower', 'a_follower', 'Follower', 'agent', new Date().toISOString())
ctx.session.join({ sessionId: 's_decisions', principalId: 'u_dec_dri', role: 'DRI' })
ctx.session.join({ sessionId: 's_decisions', principalId: 'u_dec_member', role: '成员' })
ctx.session.join({ sessionId: 's_decisions', principalId: 'a_dec_writer', role: '成员' })
ctx.session.join({ sessionId: 's_decisions', principalId: 'a_dec_follower', role: '成员' })
applyDecisionCommands(ctx)
let redoPlan: { mentions: string[]; event: { replyTo?: string | null } } | undefined
ctx.on('space/plan', (signal) => { redoPlan = signal })

function agentAnswer(id: string, text: string) {
  return eventLog.append({
    id, sessionId: 's_decisions', authorId: 'a_dec_writer', phaseId: null,
    authorKind: 'agent', kind: 'message', text, mentions: [], toolCalls: [], replyMode: '',
  })
}
async function decision(authorId: string, text: string): Promise<string> {
  const result = await ctx.commands.dispatch(
    { sessionId: 's_decisions', authorId, arg: '', args: [], raw: text },
    { name: 'decision', rest: text.replace(/^\/decision\s+/, '') },
  )
  return result.text
}
async function finalDecision(authorId: string, text: string): Promise<string> {
  const first = await decision(authorId, text)
  return first.includes('再次从回复卡片提交决策') ? decision(authorId, text) : first
}

async function main(): Promise<void> {
  const protectedAnswer = agentAnswer('evt_protected', '先暂缓发布。')
  assert.match(await decision('u_dec_member', `/decision pass ${protectedAnswer.id}`), /只有本会话 DRI/)
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === protectedAnswer.id)?.voided, false,
    'non-DRI cannot decide another Agent response')

  assert.match(await decision('u_dec_dri', `/decision pass ${protectedAnswer.id} 已核对`), /再次从回复卡片提交决策/,
    'the first final command opens and completes a review without deciding')
  assert.match(await decision('u_dec_dri', `/decision pass ${protectedAnswer.id} 已核对`), /已通过/)
  const approval = eventLog.listBySession('s_decisions').find((event) => event.kind === 'approval')!
  assert.equal(approval.replyTo, protectedAnswer.id, 'approval retains an explicit target link')
  assert.match(approval.text, /DRI 决策：通过/, 'decision record is readable in the session timeline')
  assert.equal(redoPlan?.event.id, approval.id, 'pass resumes orchestration from the linked approval event')

  const rejected = agentAnswer('evt_rejected', '错误的配置建议')
  const downstream = eventLog.append({
    id: 'evt_downstream', sessionId: 's_decisions', authorId: 'a_dec_follower', phaseId: null,
    authorKind: 'agent', kind: 'message', text: '另一个 Agent 基于错误建议给出的结论',
    mentions: [], toolCalls: [], replyMode: '', sourceEventId: rejected.id,
    sourceEventIds: [protectedAnswer.id],
  })
  assert.equal(downstream.sourceEventId, rejected.id)
  assert.deepEqual(new Set(downstream.sourceEventIds), new Set([rejected.id, protectedAnswer.id]),
    'event provenance retains every cited source')
  assert.equal(downstream.replyTo, null, 'causal provenance does not turn into a visible quote')
  const secondDownstream = eventLog.append({
    id: 'evt_second_downstream', sessionId: 's_decisions', authorId: 'a_dec_writer', phaseId: null,
    authorKind: 'agent', kind: 'message', text: '后续 Agent 再次引用下游结论',
    mentions: [], toolCalls: [], replyMode: '', sourceEventId: downstream.id,
  })
  await memory.remember('agent:a_dec_writer', 'conversation_fact:0', '来源于待否决回答', {
    sourceEventId: rejected.id, authorId: 'a_dec_writer',
  })
  await memory.remember('agent:a_dec_follower', 'conversation_fact:0', '来源于下游回答', {
    sourceEventId: downstream.id, authorId: 'a_dec_follower',
  })
  await memory.remember('agent:a_dec_writer', 'conversation_fact:1', '来源于二级下游回答', {
    sourceEventId: secondDownstream.id, authorId: 'a_dec_writer',
  })
  const mixedMemory = await memory.remember('agent:a_dec_writer', 'conversation_fact:mixed', '综合两条回答形成的记忆', {
    sourceEventId: rejected.id, sourceEventIds: [protectedAnswer.id], authorId: 'a_dec_writer',
  })
  assert.deepEqual(new Set(mixedMemory.sourceEventIds), new Set([rejected.id, protectedAnswer.id]))
  let lateDownstream: SessionEvent | undefined
  duringInboxWait = async () => {
    lateDownstream = eventLog.append({
      id: 'evt_late_downstream', sessionId: 's_decisions', authorId: 'a_dec_follower', phaseId: null,
      authorKind: 'agent', kind: 'message', text: '在撤回等待期间新产生的派生回答',
      mentions: [], toolCalls: [], replyMode: '', sourceEventId: downstream.id,
    })
    await memory.remember('agent:a_dec_follower', 'conversation_fact:late', '撤回等待期间提取的记忆', {
      sourceEventId: lateDownstream.id, authorId: 'a_dec_follower',
    })
  }
  assert.match(await finalDecision('u_dec_dri', `/decision reject ${rejected.id} 安全依据不足`), /已否决该回答/)
  assert(cancelledSources.includes(rejected.id), 'withdrawal cancels active work rooted at the rejected Agent answer')
  assert(cancelledSources.includes(downstream.id), 'withdrawal clears active work rooted at each discovered descendant')
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === rejected.id)?.voided, true)
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === downstream.id)?.voided, true,
    'veto invalidates Agent replies that cite the rejected result as their causal source')
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === secondDownstream.id)?.voided, true,
    'veto traverses transitive Agent reply dependencies')
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === lateDownstream?.id)?.voided, true,
    'veto re-scans causal descendants produced during the Agent inbox wait barrier')
  assert.equal((await memory.recall('agent:a_dec_writer')).some((item) =>
    item.sourceEventId === rejected.id || item.sourceEventId === secondDownstream.id), false,
  'veto invalidates direct and transitive Agent memories')
  assert.equal((await memory.recall('agent:a_dec_follower')).some((item) => item.sourceEventId === downstream.id), false,
    'veto invalidates memories derived from downstream Agent replies')
  assert.equal((await memory.recall('agent:a_dec_follower')).some((item) => item.sourceEventId === lateDownstream?.id), false,
    'veto invalidates memories produced while the Agent inbox barrier was draining')
  assert.equal((await memory.recall('agent:a_dec_writer')).some((item) => item.id === mixedMemory.id), false,
    'a mixed-source memory is excluded when any source is withdrawn')
  assert.equal(db.prepare('SELECT invalidated_at FROM memories WHERE id = ?').get(mixedMemory.id)?.invalidated_at != null, true,
    'invalidated memories remain stored for audit')
  assert.deepEqual(rebuildCalls.find((call) => call.itemId === mixedMemory.id)?.sourceIds, [protectedAnswer.id],
    'DRI withdrawal asks the Agent Inbox to rebuild mixed memories from remaining valid sources only')
  const vetoEvent = eventLog.listBySession('s_decisions').find((event) =>
    event.kind === 'decision' && event.replyTo === rejected.id && event.text.includes('DRI 决策：否决'))!
  const impactRecord = eventLog.listBySession('s_decisions').find((event) =>
    event.kind === 'system' && event.replyTo === vetoEvent.id && event.text.startsWith('【决策影响记录】'))
  assert(impactRecord?.text.includes(rejected.id) && impactRecord.text.includes(mixedMemory.id),
    'the linked impact record identifies withdrawn events and invalidated memory snapshots')
  assert.match(eventLog.listBySession('s_decisions').find((event) => event.id === rejected.id)?.voidedReason ?? '',
    new RegExp(`decision=${vetoEvent.id}`), 'voided source audit reasons link back to the final DRI decision ID')
  assert.match(await decision('u_dec_dri', `/decision redo ${secondDownstream.id} 按新的有效上下文重做`), /定向交回原 Agent/,
    'a voided downstream Agent reply can be explicitly requeued from the DRI menu/command')
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === secondDownstream.id)?.voided, true,
    'replaying a historical impact item does not restore its invalidated answer to context')
  assert.deepEqual(redoPlan?.mentions, ['a_dec_writer'], 'historical replay is routed to the original Agent identity')
  assert(eventLog.listBySession('s_decisions').some((event) => event.kind === 'decision' && event.replyTo === rejected.id),
    'veto is recorded as a linked decision event')

  ctx.session.createSession({ id: 's_other', title: '隔离检查' })
  assert.throws(() => eventLog.append({
    id: 'evt_cross_session', sessionId: 's_other', authorId: 'a_dec_writer', phaseId: null,
    authorKind: 'agent', kind: 'message', text: '不应跨会话引用因果来源',
    mentions: [], toolCalls: [], replyMode: '', sourceEventId: protectedAnswer.id,
  }), /因果来源不存在、已撤回或属于其他会话/)

  const redoTarget = agentAnswer('evt_redo', '需要修正的回答')
  assert.match(await finalDecision('u_dec_dri', `/decision redo ${redoTarget.id} 重新核验兼容性`), /提交重做要求/)
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === redoTarget.id)?.voided, true)
  const redoRequest = eventLog.listBySession('s_decisions').find((event) => event.text.includes('重新回答'))!
  assert.equal(redoRequest.authorKind, 'human')
  assert.deepEqual(redoRequest.mentions, ['a_dec_writer'])
  assert.equal(redoRequest.replyTo, redoTarget.id)
  assert.deepEqual(redoPlan?.mentions, ['a_dec_writer'], 'redo is routed through the normal targeted Agent pipeline')
  assert.equal(redoPlan?.event.replyTo, redoTarget.id)

  const modifyTarget = agentAnswer('evt_modify', '需要调整的建议')
  assert.match(await finalDecision('u_dec_dri', `/decision modify ${modifyTarget.id} 保留结论，补上回滚步骤`), /按修改意见重新提交/)
  assert.equal(eventLog.listBySession('s_decisions').find((event) => event.id === modifyTarget.id)?.voided, true,
    'modify retains the original answer but removes it from valid context')
  const modifyRequest = eventLog.listBySession('s_decisions').find((event) => event.text.includes('按 DRI 的修改意见修订'))!
  assert.match(modifyRequest.text, /保留结论，补上回滚步骤/)
  assert.equal(modifyRequest.replyTo, modifyTarget.id, 'modify request links to the answer it replaces')
  assert.deepEqual(redoPlan?.mentions, ['a_dec_writer'], 'modify is sent only to the original Agent')
  assert.equal(redoPlan?.event.replyTo, modifyTarget.id)
  assert(eventLog.listBySession('s_decisions').some((event) => event.text.includes('DRI 决策：修改') && event.replyTo === modifyTarget.id),
    'modify decision is recorded as a linked session event')

console.log('✓ DRI decisions enforce session role, retain linked records, invalidate source memories, and route targeted redo/modify')
  db.close()
}

await main()
