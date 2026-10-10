import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type { SessionEvent } from 'space-event'
import { apply as applyFlowCommands, recoverFlowFromEvents } from '../plugins/flow-commands/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'

function systemEvent(id: string, seq: number, text: string): SessionEvent {
  return {
    id, sessionId: 's_recovery', seq, ts: new Date(seq).toISOString(), authorId: null,
    authorKind: 'system', kind: 'system', text, mentions: [], toolCalls: [], replyMode: '',
    sourceEventId: null, sourceEventIds: [], voided: false, voidedBy: null,
    voidedAt: null, voidedReason: null,
  }
}

const flows = { code: ['编码者', '测试者', '代码审查者'], test: ['测试者', '代码审查者'] }
const start = systemEvent('flow-start', 1, '⚙ 服务流程 [code] 启动：修复上传（步骤：编码者 → 测试者 → 代码审查者）')
const recoveredFirst = recoverFlowFromEvents('s_recovery', [start], flows)
assert.equal(recoveredFirst?.flow.name, 'code')
assert.equal(recoveredFirst?.flow.task, '修复上传')
assert.equal(recoveredFirst?.flow.idx, 1)
assert.equal(recoveredFirst?.dispatchEvent.id, 'flow-start')

const progress = systemEvent('flow-step-2', 3, '⚙ 流程推进（2/3）：交给「测试者」')
const recoveredSecond = recoverFlowFromEvents('s_recovery', [start, progress], flows)
assert.equal(recoveredSecond?.flow.idx, 2)
assert.equal(recoveredSecond?.flow.steps[recoveredSecond.flow.idx - 1], '测试者')
assert.equal(recoveredSecond?.dispatchEvent.id, 'flow-step-2')

const complete = systemEvent('flow-done', 5, '⚙ 服务流程 [code] 完成（编码者 → 测试者 → 代码审查者）')
assert.equal(recoverFlowFromEvents('s_recovery', [start, progress, complete], flows), null)
const paused = systemEvent('flow-paused', 5, '⚙ 流程 [code] 暂停：「代码审查者」正在其它任务中。')
assert.equal(recoverFlowFromEvents('s_recovery', [start, progress, paused], flows), null)
assert.equal(recoverFlowFromEvents('s_recovery', [start], { test: flows.test }), null,
  'a removed flow command is not silently replayed')

async function exercisePluginRecovery(history: SessionEvent[], expectedTarget: string, expectedEventId: string): Promise<void> {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const migrationDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
  for (const migration of loadMigrations(migrationDir)) db.exec(migration.up)
  const beforeRestart = new Context() as Context & Record<string, any>
  new SqliteSessionStore(beforeRestart, db).createSession({ id: 's_recovery', title: '恢复验收' })
  const firstEventLog = new SqliteEventLog(beforeRestart, db)
  for (const event of history) firstEventLog.append({
    id: event.id, sessionId: event.sessionId, authorId: event.authorId, phaseId: event.phaseId,
    authorKind: event.authorKind, kind: event.kind, text: event.text, mentions: event.mentions,
    toolCalls: event.toolCalls, replyMode: event.replyMode, sourceEventId: event.sourceEventId,
  })
  const ctx = new Context() as Context & Record<string, any>
  const eventLog = new SqliteEventLog(ctx, db)
  const sessionStore = new SqliteSessionStore(ctx, db)
  const dispatched: Array<{ eventId: string; target: string; instruction: string }> = []
  Object.assign(ctx, {
    commands: { register: () => undefined },
    eventLog,
    session: sessionStore,
    agents: { list: () => [
      { descriptor: { id: 'a_coder', title: '编码者' }, status: 'idle' },
      { descriptor: { id: 'a_tester', title: '测试者' }, status: 'idle' },
      { descriptor: { id: 'a_reviewer', title: '代码审查者' }, status: 'idle' },
    ] },
    orchestrator: { beginExternalDelegate: (sessionId: string, eventId: string, target: string, instruction: string) => {
      assert.equal(sessionId, 's_recovery')
      dispatched.push({ eventId, target, instruction })
    } },
    sessionWork: { state: () => ({ activeSessionId: null, owners: [], queue: [] }) },
    settings: { get: (_key: string, fallback: unknown) => fallback },
  })
  applyFlowCommands(ctx, { flows })
  ctx.emit('app/ready')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(dispatched.length, 1, 'startup recovery dispatches exactly the recorded current step')
  assert.equal(dispatched[0]?.target, expectedTarget)
  assert.equal(dispatched[0]?.eventId, expectedEventId, 'recovery reuses the durable dispatch event id')
  if (expectedTarget === '编码者') {
    assert.equal(dispatched[0]?.instruction, '修复上传')
    eventLog.append({
      id: 'coder-result', sessionId: 's_recovery', authorId: 'a_coder', phaseId: null,
      authorKind: 'agent', kind: 'message', text: '修复已提交', mentions: [], toolCalls: [], replyMode: '',
      sourceEventId: expectedEventId,
    })
    assert.equal(dispatched[1]?.target, '测试者', 'a recovered flow advances after the restored step returns')
  }
  db.close()
}

await exercisePluginRecovery([start], '编码者', 'flow-start')
await exercisePluginRecovery([start, progress], '测试者', 'flow-step-2')

async function verifyCatalogFlowInvitation(): Promise<void> {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const migrationDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
  for (const migration of loadMigrations(migrationDir)) db.exec(migration.up)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at)
    VALUES ('custom_helper_42', 'helper', '!', 'Custom Helper', 'agent', ?)`).run(now)
  const ctx = new Context() as Context & Record<string, any>
  const sessionStore = new SqliteSessionStore(ctx, db)
  const eventLog = new SqliteEventLog(ctx, db)
  const session = sessionStore.createSession({ id: 's_custom_flow', title: 'Custom Agent flow' })
  const registrations: Array<{ name: string; run: (context: any) => unknown }> = []
  const dispatched: string[] = []
  Object.assign(ctx, {
    commands: { register: (command: any) => registrations.push(command) },
    eventLog,
    session: sessionStore,
    agents: { list: () => [{ descriptor: { id: 'custom_helper_42', title: 'Custom Helper' }, status: 'idle' }] },
    orchestrator: { beginExternalDelegate: (_sessionId: string, _eventId: string, target: string) => dispatched.push(target) },
    sessionWork: { state: () => ({ activeSessionId: null, owners: [], queue: [] }) },
    settings: { get: (_key: string, fallback: unknown) => fallback },
  })
  applyFlowCommands(ctx, { flows: { custom: ['Custom Helper'] } })
  const customCommand = registrations.find((command) => command.name === 'custom')
  assert.ok(customCommand, 'configured flow command is registered')
  const run = () => customCommand.run({ sessionId: session.id, arg: 'review this request' })
  assert.match((run() as { text: string }).text, /尚未加入此会话/)
  assert.equal(dispatched.length, 0, 'a catalog Agent cannot receive a flow assignment before invitation')
  sessionStore.join({ sessionId: session.id, principalId: 'custom_helper_42', role: '成员', duty: 'Custom Helper' })
  assert.match((run() as { text: string }).text, /流程已启动/)
  assert.deepEqual(dispatched, ['Custom Helper'], 'an invited custom Agent with a non-special ID can receive the assignment')
  db.close()
}

await verifyCatalogFlowInvitation()

console.log('✓ Flow recovery, shared-catalog lookup, and invitation checks passed')
