// verify-orchestrator.ts —— P3 端到端验收（第八门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 5 节 P3 行 + 第 7 节待定 5（可断言子集）。
//   Part A（进程内，桩大脑离线重放 —— 旧 Coordinator interface 的门禁口径）：
//     授权名单（三目标 agent、协调者不在册、非 active 剔除）、名单外必拒、
//     未注册大脑 → 暂停、每回合恰好一次决策、NLP 判定口径（@ 只是提示、
//     人类原话逐字透传）、三级兜底（policy 纯函数逐层对拍 + 引擎落点）、
//     负面语气/多目标/空输出护栏、收到目标反馈后必须暂停（await_human）。
//   Part B（对运行中的后端）：接线 —— 被 @ 提及的普通消息触发 Plan 后
//     orchestrator 确实接管（回合存在、每回合恰好一次），
//     经 GET /api/sessions/:id/turn 只读口观测。
//
// 前提：后端已在 APP_PORT 运行（属于 gate:runtime，运行前需启动后端）。
// 用法：npm run verify:orchestrator    退出码 0 = 全过；1 = 判红。
//   npm run verify:orchestrator:core    只跑离线引擎、双进程恢复与队列断言。
// 留痕：全部通过后记一行 action_log: verify-orchestrator（断言 ⑨）。
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type { PlanRequest } from 'space-orchestrator'
import { OrchestratorError } from 'space-orchestrator'
import { authorizedTargets, isAuthorizedTarget, parseCoordinatorOutput } from 'space-authz'
import type { OrchestratorBrain } from 'space-orchestrator'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { InboxPauseNoticeGate, OrchestratorEngine } from '../plugins/orchestrator/index.ts'
import { SessionWork } from '../plugins/session-work/index.ts'

// ── 断言器（与 本地 verifier 同款）────────────────────────────────────────
let failures = 0
let passes = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──────────────────────────`)
}

section('消息顺序屏障提示去重')
const inboxPauseGate = new InboxPauseNoticeGate()
check('同一会话的一轮连续追赶失败只显示一次暂停提示',
  inboxPauseGate.shouldAnnounce('s_inbox_pause') && !inboxPauseGate.shouldAnnounce('s_inbox_pause') &&
    inboxPauseGate.shouldAnnounce('s_other_pause'))
inboxPauseGate.recovered('s_inbox_pause')
check('消息顺序追赶恢复后允许显示下一次暂停提示', inboxPauseGate.shouldAnnounce('s_inbox_pause'))

// ── 端口：.env 唯一出处（与 .env 端口约定）──────────────────────────
function readPort(): number {
  if (process.env.APP_PORT) return Number(process.env.APP_PORT)
  const envPath = new URL('../.env', import.meta.url)
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^APP_PORT=(\d+)/m)
    if (m) return Number(m[1])
  }
  return 8080
}
const PORT = readPort()
const BASE = `http://127.0.0.1:${PORT}`

// ── 桩大脑：可编程的协调者（门禁离线重放的"模型"）─────────────────────────
let rawOut = ''
let lastReq: PlanRequest | null = null
const scriptedBrain: OrchestratorBrain = {
  async plan(req) {
    lastReq = req
    if (rawOut === '__THROW__') throw new Error('模型超时（桩）')
    return rawOut
  },
}

function openInMemory(): { ctx: Context; db: DatabaseSync; engine: OrchestratorEngine } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
  for (const m of loadMigrations(migrationsDir)) db.exec(m.up)
  const insSession = db.prepare(
    `INSERT INTO sessions(id, title, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)`,
  )
  const insMember = db.prepare(
    `INSERT INTO session_members(session_id, principal_id, role, status, joined_at) VALUES (?, ?, ?, 'active', ?)`,
  )
  const t = '2026-01-01T00:00:00.000Z'
  insSession.run('s_a', '验收A（全员）', t, t)
  // 完整名册：人类 DRI + 协调者 + 三个目标 agent（含在册协调者 —— 它**不在**授权名单）
  for (const [pid, role] of [
    ['u_dri', 'DRI'],
    ['a_coordinator', '协调者'],
    ['a_analyst', '需求分析师'],
    ['a_recorder', '会议记录官'],
    ['a_challenger', '挑战者'],
  ] as const) {
    insMember.run('s_a', pid, role, t)
  }
  insSession.run('s_b', '验收B（名册不全）', t, t)
  insMember.run('s_b', 'u_dri', 'DRI', t)
  insMember.run('s_b', 'a_coordinator', '协调者', t)
  insMember.run('s_b', 'a_analyst', '需求分析师', t)
  // 已离开的记录官：证明非 active 成员不进名单
  db.prepare(
    `INSERT INTO session_members(session_id, principal_id, role, status, joined_at, left_at)
     VALUES ('s_b', 'a_recorder', '会议记录官', 'left', ?, ?)`,
  ).run(t, t)

  const ctx = new Context()
  new SqliteSessionStore(ctx, db) // 提供 ctx.session
  new SqliteEventLog(ctx, db) // 提供 ctx.eventLog
  new SqliteSettingsStore(ctx, db) // 提供 Orchestrator 持久状态
  new SessionWork(ctx)
  const engine = new OrchestratorEngine(ctx)
  return { ctx, db, engine }
}

let humanSeq = 0
function humanCommit(ctx: Context, sessionId: string, text: string, mentions: string[] = []) {
  humanSeq++
  const event = ctx.eventLog.append({
    id: randomUUID(),
    sessionId,
    authorId: 'u_dri',
    phaseId: null,
    authorKind: 'human',
    kind: 'message',
    text,
    mentions,
    toolCalls: [],
    replyMode: '',
  })
  return { sessionId, authorId: 'u_dri', event }
}

async function verifyQueuedPlans(): Promise<void> {
  section('单活动会话队列：保留跨会话触发并按 FIFO 自动启动')
  const { ctx, db, engine } = openInMemory()
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  let calls = 0
  engine.registerBrain({
    async plan() {
      calls++
      if (calls === 1) await firstBlocked
      return JSON.stringify({ reply: '已处理', reason: '完成', delegate: null })
    },
  })
  const first = engine.onPlan(humanCommit(ctx, 's_a', '先处理会话 A'))
  await new Promise((resolve) => setImmediate(resolve))
  check('Q0 协调器持有共享活动会话槽位', ctx.sessionWork.state().activeSessionId === 's_a')
  await engine.onPlan(humanCommit(ctx, 's_b', '排队处理会话 B'))
  check('Q1 活动会话期间第二会话不丢弃，显示 FIFO 等待事件',
    ctx.eventLog.listBySession('s_b').some((event) => event.text.includes('第 1 位') && event.text.includes('排队')) &&
      ctx.sessionWork.state().queue.some((item) => item.sessionId === 's_b'))
  releaseFirst()
  await first
  for (let i = 0; i < 20 && engine.turn('s_b').stopReason !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  check('Q2 前一回合结束后自动启动并完成排队会话', calls === 2 && engine.turn('s_b').stopReason === 'completed',
    `calls=${calls}, turn=${JSON.stringify(engine.turn('s_b'))}`)
  check('Q3 排队启动顺序有可见留痕',
    ctx.eventLog.listBySession('s_b').some((event) => event.text.includes('排队任务开始处理')))
  let externalDispatched = false
  ctx.on('orchestrator/delegate', () => { externalDispatched = true })
  ctx.sessionWork.tryEnter('s_a', 'agent-inbox')
  engine.beginExternalDelegate('s_b', 'evt_external_queued', '编码者', '排队的编码任务')
  check('Q4 流程轨委托也进入共享会话队列',
    !externalDispatched && ctx.eventLog.listBySession('s_b').some((event) => event.text.includes('流程任务已排队')))
  ctx.sessionWork.leave('s_a', 'agent-inbox')
  engine.wakeQueue()
  for (let i = 0; i < 20 && !externalDispatched; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  check('Q5 共享槽位空闲后派发排队流程任务', externalDispatched &&
    ctx.sessionWork.state().activeSessionId === 's_b' && engine.turn('s_b').state === 'chain')
  ctx.sessionWork.leave('s_b', 'orchestrator:s_b')

  // Recovery must survive the gate becoming free and being claimed by a FIFO
  // competitor before the queued recovery microtask runs. The next release
  // notification must wake the persisted Plan instead of leaving it stranded.
  ctx.on('session-work/changed', () => engine.wakeQueue())
  const callsBeforeRecovery = calls
  const recoveryPlan = humanCommit(ctx, 's_a', '队列与恢复交错验收')
  ctx.settings.set('orchestrator.runtime.v1', {
    version: 1,
    turns: [['s_a', {
      state: 'chain', decisionCalls: 0, autonomousActions: 0, delegatedTargets: [], stopReason: '', stopDetail: '',
    }]],
    delegations: [], queue: [], activeDecisions: [{ payload: recoveryPlan, resetTurn: true }],
  })
  const blockerAdmitted = ctx.sessionWork.tryEnter('s_recovery_blocker', 'agent-inbox')
  const competitorQueued = !ctx.sessionWork.tryEnter('s_fifo_competitor', 'agent-worker')
  engine.recoverPersistedWork()
  check('Q6 活跃租约期间恢复任务设置等待屏障', blockerAdmitted && competitorQueued && calls === callsBeforeRecovery)
  ctx.sessionWork.leave('s_recovery_blocker', 'agent-inbox')
  // session-work/changed schedules recovery on a microtask; synchronously let
  // the existing FIFO head claim the empty slot before that callback runs.
  const competitorAdmitted = ctx.sessionWork.tryEnter('s_fifo_competitor', 'agent-worker')
  await new Promise((resolve) => setImmediate(resolve))
  check('Q7 FIFO 竞争者先占槽时恢复 Plan 仍留在持久队列', competitorAdmitted && calls === callsBeforeRecovery &&
    ctx.settings.get<Record<string, any>>('orchestrator.runtime.v1', {}).queue?.some((item: any) =>
      item.kind === 'plan' && item.payload?.event?.id === recoveryPlan.event.id))
  ctx.sessionWork.leave('s_fifo_competitor', 'agent-worker')
  for (let i = 0; i < 40 && engine.turn('s_a').stopReason !== 'completed'; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  check('Q8 后续租约释放重新唤醒恢复，且只执行一次', calls === callsBeforeRecovery + 1 &&
    engine.turn('s_a').stopReason === 'completed' &&
    ctx.eventLog.listBySession('s_a').filter((event) => event.id === `orchestrator_reply_${recoveryPlan.event.id}`).length === 1,
    `calls=${calls - callsBeforeRecovery}, turn=${JSON.stringify(engine.turn('s_a'))}`)
  db.close()
}

async function verifyDecisionPause(): Promise<void> {
  section('Agent 结构化 DRI 决策请求：暂停并等待命令解除')
  const { ctx, db, engine } = openInMemory()
  let calls = 0
  engine.registerBrain({
    async plan() {
      calls++
      return JSON.stringify(calls === 1
        ? { reply: '', reason: '明确授权', delegate: { target: '需求分析师', instruction: '评估方案' } }
        : { reply: '已按 DRI 决定继续', reason: '完成', delegate: null })
    },
  })
  const trigger = humanCommit(ctx, 's_a', '评估方案', ['a_analyst'])
  await engine.onPlan(trigger)
  const answer = engine.reportFeedback('s_a', '需求分析师', '建议采用方案 A。\n【需要DRI决策】是否接受方案 A？')
  engine.handleAgentEvent(answer)
  check('D1 Agent 使用显式标记后回合暂停等待 DRI', engine.turn('s_a').stopReason === 'await_human_decision')
  await engine.onPlan(humanCommit(ctx, 's_a', '继续处理依赖该方案的任务'))
  check('D2 等待期间新任务留在可见队列且协调者没有继续调用', calls === 1 &&
    ctx.eventLog.listBySession('s_a').some((event) => event.text.includes('会话有 Agent 建议正在等待 DRI 决策')))
  const approval = ctx.eventLog.append({
    id: randomUUID(), sessionId: 's_a', authorId: 'u_dri', phaseId: null,
    authorKind: 'human', kind: 'approval', text: 'DRI 决策：通过',
    mentions: [], toolCalls: [], replyMode: '', replyTo: answer.id,
  })
  await engine.onPlan({ sessionId: 's_a', authorId: 'u_dri', event: approval })
  for (let i = 0; i < 20 && engine.turn('s_a').stopReason !== 'completed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  check('D3 DRI 通过后解除等待并处理已排队任务', calls >= 2 && engine.turn('s_a').stopReason === 'completed',
    `calls=${calls}, turn=${JSON.stringify(engine.turn('s_a'))}`)
  db.close()
}

async function verifyCancelledDelegationLedger(): Promise<void> {
  section('撤回来源后清除对应在途委托账本')
  const { ctx, db, engine } = openInMemory()
  engine.registerBrain({
    async plan() {
      return JSON.stringify({ reply: '', reason: '明确授权', delegate: { target: '需求分析师', instruction: '处理可撤回任务' } })
    },
  })
  const trigger = humanCommit(ctx, 's_a', '处理可撤回任务', ['a_analyst'])
  await engine.onPlan(trigger)
  const cancelled = engine.cancelDelegationsBySource('s_a', trigger.event.id)
  let rejected = false
  try { engine.reportFeedback('s_a', '需求分析师', '不应提交旧结果') }
  catch (error) { rejected = error instanceof OrchestratorError && error.code === 'not_delegating' }
  check('D4 已撤回触发源的委托从账本移除并拒收迟到回执',
    cancelled.includes('需求分析师') && rejected && engine.turn('s_a').delegatedTargets.length === 0)
  db.close()
}

async function verifyDurableRecovery(): Promise<void> {
  section('Orchestrator 重启恢复：SQLite 回合与未完成委托')
  const { ctx, db, engine } = openInMemory()
  ctx.on('space/event-appended', ({ event }) => engine.handleAgentEvent(event))
  engine.registerBrain({
    async plan() {
      return JSON.stringify({ reply: '', reason: '明确授权', delegate: { target: '需求分析师', instruction: '跨重启恢复任务' } })
    },
  })
  const trigger = humanCommit(ctx, 's_a', '跨重启恢复任务', ['a_analyst'])
  await engine.onPlan(trigger)
  const queuedPlan = humanCommit(ctx, 's_b', '等待前序会话完成')
  await engine.onPlan(queuedPlan)
  const persistedBefore = ctx.settings.get<Record<string, unknown>>('orchestrator.runtime.v1', {})

  const restarted = new Context()
  new SqliteSessionStore(restarted, db)
  new SqliteEventLog(restarted, db)
  new SqliteSettingsStore(restarted, db)
  const recovered: Array<{ sessionId: string; eventId: string; target: string; instruction: string }> = []
  restarted.on('orchestrator/delegate', (payload) => recovered.push(payload))
  const restartedEngine = new OrchestratorEngine(restarted)
  restartedEngine.recoverPersistedWork()
  for (let i = 0; i < 20 && recovered.length === 0; i++) await new Promise((resolve) => setImmediate(resolve))
  check('R1 SQLite 快照包含 chain 回合和委托来源',
    JSON.stringify(persistedBefore).includes('需求分析师') && JSON.stringify(persistedBefore).includes(trigger.event.id))
  check('R2 新引擎实例恢复未完成委托且复用来源事件 id',
    recovered.length === 1 && recovered[0]?.sessionId === 's_a' && recovered[0]?.eventId === trigger.event.id &&
      recovered[0]?.target === '需求分析师' && recovered[0]?.instruction === '跨重启恢复任务',
    JSON.stringify(recovered))
  check('R3 恢复后的 turn 保留自治预算与 chain 状态',
    restartedEngine.turn('s_a').state === 'chain' && restartedEngine.turn('s_a').decisionCalls === 1 &&
      restartedEngine.turn('s_a').autonomousActions === 1)
  const persistedAfter = restarted.settings.get<Record<string, unknown>>('orchestrator.runtime.v1', {})
  check('R4 跨会话 FIFO Plan 在 SQLite 中保留并等待活动回合',
    JSON.stringify(persistedAfter).includes(queuedPlan.event.id) && recovered.length === 1 &&
      restartedEngine.turn('s_b').state === 'static')
  db.close()

  const interrupted = openInMemory()
  let brainStarted!: () => void
  const started = new Promise<void>((resolve) => { brainStarted = resolve })
  interrupted.engine.registerBrain({
    async plan() {
      brainStarted()
      return await new Promise<string>(() => undefined)
    },
  })
  const pendingPlan = humanCommit(interrupted.ctx, 's_a', '模型调用期间崩溃')
  void interrupted.engine.onPlan(pendingPlan)
  await started
  const processRestart = new Context()
  new SqliteSessionStore(processRestart, interrupted.db)
  const restartedLog = new SqliteEventLog(processRestart, interrupted.db)
  new SqliteSettingsStore(processRestart, interrupted.db)
  const recoveredEngine = new OrchestratorEngine(processRestart)
  recoveredEngine.registerBrain({ async plan() { return JSON.stringify({ reply: '恢复后完成', reason: '完成', delegate: null }) } })
  recoveredEngine.recoverPersistedWork()
  for (let i = 0; i < 40 && recoveredEngine.turn('s_a').stopReason !== 'completed'; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const stableReplyId = `orchestrator_reply_${pendingPlan.event.id}`
  check('R5 模型决策期间崩溃后按持久 Plan 恢复，回复使用稳定幂等事件 ID',
    recoveredEngine.turn('s_a').stopReason === 'completed' &&
      restartedLog.listBySession('s_a').filter((event) => event.id === stableReplyId).length === 1)
  interrupted.db.close()
}

async function verifyOrphanedChainRecovery(): Promise<void> {
  section('持久恢复：没有待恢复工作的遗留 chain 必须释放会话槽位')
  const seed = openInMemory()
  seed.ctx.settings.set('orchestrator.runtime.v1', {
    version: 1,
    turns: [['s_a', {
      state: 'chain', decisionCalls: 1, autonomousActions: 1,
      delegatedTargets: [], stopReason: '', stopDetail: '',
    }]],
    delegations: [], queue: [], activeDecisions: [],
  })
  const restarted = new Context()
  new SqliteSessionStore(restarted, seed.db)
  new SqliteEventLog(restarted, seed.db)
  new SqliteSettingsStore(restarted, seed.db)
  new SessionWork(restarted)
  let pauseReason = ''
  restarted.on('orchestrator/pause', (payload) => { pauseReason = payload.stopReason })
  const engine = new OrchestratorEngine(restarted)
  engine.recoverPersistedWork()
  check('R6 无活跃决策/委托/队列任务的 chain 被标记为 recovery_orphaned',
    engine.turn('s_a').state === 'static' && engine.turn('s_a').stopReason === 'recovery_orphaned' &&
      pauseReason === 'recovery_orphaned')
  check('R7 孤儿 chain 恢复后不再占用单会话槽位', restarted.sessionWork.state().activeSessionId === null)
  seed.db.close()
}

async function verifyConcurrentEngineRecovery(): Promise<void> {
  section('跨进程恢复：同一持久 Plan 只允许一个 Orchestrator 决策')
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-orchestrator-race-'))
  const dbPath = join(dir, 'orchestrator.db')
  const roles = ['orchestrator-a', 'orchestrator-b']
  const children: Array<{
    role: string
    child: ReturnType<typeof spawn>
    output: string
    closed: Promise<{ role: string; code: number | null }>
  }> = []
  try {
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
    for (const migration of loadMigrations(migrationsDir)) db.exec(migration.up)
    const timestamp = new Date().toISOString()
    db.prepare(`INSERT INTO sessions(id, title, status, created_at, updated_at)
      VALUES ('s_engine_race', '并发恢复验收', 'open', ?, ?)`).run(timestamp, timestamp)
    db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at)
      VALUES ('a_engine_race', 'a_engine_race', '!', '并发验收协调者', 'agent', ?)`).run(timestamp)
    db.prepare(`INSERT INTO session_members(session_id, principal_id, role, status, joined_at)
      VALUES ('s_engine_race', 'a_engine_race', '协调者', 'active', ?)`).run(timestamp)
    // Hold the shared slot before either process starts recovery. This forces
    // both engines down recoveryPending and exercises the post-wait refresh.
    db.prepare(`INSERT INTO session_work_owners(process_id, session_id, owner, expires_at)
      VALUES ('test-lease-holder', 's_engine_race', 'orchestrator:s_engine_race', ?)`).run(Date.now() + 30_000)
    const seed = new Context()
    new SqliteSessionStore(seed, db)
    new SqliteEventLog(seed, db)
    new SqliteSettingsStore(seed, db)
    const event = seed.eventLog.append({
      id: 'event_engine_race', sessionId: 's_engine_race', authorId: 'u_dri', phaseId: null,
      authorKind: 'human', kind: 'message', text: '恢复验收计划', mentions: [], toolCalls: [], replyMode: '',
    })
    const payload = { sessionId: event.sessionId, authorId: event.authorId!, event }
    seed.settings.set('orchestrator.runtime.v1', {
      version: 1,
      turns: [['s_engine_race', {
        state: 'chain', decisionCalls: 0, autonomousActions: 0, delegatedTargets: [], stopReason: '', stopDetail: '',
      }]],
      delegations: [], queue: [], activeDecisions: [{ payload, resetTurn: true }],
    })
    db.close()

    for (const role of roles) {
      const child = spawn(process.execPath, [
        '--import', 'tsx', 'scripts/orchestrator-recovery-race-worker.ts', dbPath, role, dir,
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
      const record = {
        role,
        child,
        output: '',
        closed: new Promise<{ role: string; code: number | null }>((resolve) => {
          child.once('close', (code) => resolve({ role, code }))
        }),
      }
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { record.output += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { record.output += chunk })
      children.push(record)
    }
    const waitUntil = async (predicate: () => boolean, label: string, timeout = 10_000) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      if (!predicate()) throw new Error(`跨进程恢复测试超时：${label}`)
    }
    await waitUntil(() => roles.every((role) => existsSync(join(dir, `${role}.ready`))), '两个 worker 初始化')
    writeFileSync(join(dir, 'begin'), 'start')
    await waitUntil(() => roles.every((role) => existsSync(join(dir, `${role}.waiting-for-lease`))), '两个 worker 等待旧租约')
    const waitingWorkers = roles.filter((role) => existsSync(join(dir, `${role}.waiting-for-lease`))).length
    const releaseDb = new DatabaseSync(dbPath)
    releaseDb.exec('PRAGMA busy_timeout = 5000')
    releaseDb.prepare("DELETE FROM session_work_owners WHERE process_id = 'test-lease-holder'").run()
    releaseDb.close()
    await waitUntil(() => roles.some((role) => existsSync(join(dir, `${role}.brain-started`))), '协调大脑启动')
    const winner = roles.find((role) => existsSync(join(dir, `${role}.brain-started`)))!
    const loser = roles.find((role) => role !== winner)!
    await waitUntil(() => existsSync(join(dir, `${loser}.saw-peer-active`)), '落败进程观察到胜者持有会话槽位')
    writeFileSync(join(dir, `${winner}.release`), 'release')
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Release a second brain too if a regression started it, so the verifier
    // can report duplicate calls instead of hanging on the test barrier.
    for (const role of roles) writeFileSync(join(dir, `${role}.release`), 'release')

    const exitResults = await Promise.race([
      Promise.all(children.map(({ closed }) => closed)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 18_000)),
    ])
    if (!exitResults) {
      for (const { child } of children) child.kill('SIGKILL')
      throw new Error('跨进程恢复 worker 未能及时退出')
    }
    const brainCalls = readdirSync(dir).filter((name) => name.endsWith('.brain-started')).length
    const resultDb = new DatabaseSync(dbPath, { readOnly: true })
    const outcomeCount = (resultDb.prepare(`SELECT count(*) AS n FROM events
      WHERE session_id = ? AND author_id = ? AND source_event_id = ?`)
      .get('s_engine_race', 'a_engine_race', event.id) as { n: number }).n
    const saved = resultDb.prepare("SELECT value FROM settings WHERE key = 'orchestrator.runtime.v1'")
      .get() as { value: string }
    const finalState = JSON.parse(saved.value) as { turns: Array<[string, { stopReason: string }]> }
    const finalTurn = finalState.turns.find(([sid]) => sid === 's_engine_race')?.[1]
    resultDb.close()
    const workerErrors = exitResults.filter((result) => result.code !== 0)
      .map((result) => {
        const child = children.find((entry) => entry.role === result.role)
        return `${result.role} exit=${result.code}: ${child?.output.slice(-500) ?? ''}`
      })
    check('M1 两个独立 OS 进程恢复同一 Plan 时，大脑只调用一次', brainCalls === 1 && workerErrors.length === 0,
      `brainCalls=${brainCalls}, workers=${workerErrors.join(' | ') || 'ok'}`)
    check('M1b 两个进程均先等待旧会话租约，再恢复持久 Plan', waitingWorkers === 2,
      `waitingWorkers=${waitingWorkers}`)
    check('M2 协调者结果唯一，持久回合最终完成', outcomeCount === 1 && finalTurn?.stopReason === 'completed',
      `outcomes=${outcomeCount}, turn=${JSON.stringify(finalTurn)}`)
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

const lastEvent = (ctx: Context, sessionId: string) => {
  const evs = ctx.eventLog.listBySession(sessionId)
  return evs[evs.length - 1]
}

// ══════════════════════════════════════════════════════════════════════════
// Part A —— 进程内机制断言（:memory: 库 + 真迁移链 + 桩大脑）
// ══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  section('Part A：进程内机制断言（:memory: + 桩大脑）')
  const { ctx, engine } = openInMemory()

  let pauseCount = 0
  let lastPause: { stopReason: string; stopDetail: string } | null = null
  ctx.on('orchestrator/pause', (p) => {
    pauseCount++
    lastPause = { stopReason: p.stopReason, stopDetail: p.stopDetail }
  })

  // ── 一：授权名单（policy 纯函数）───────────────────────────────────────
  section('一：授权名单（coordinator 不在名单）')
  const roster = ctx.session.listMembers('s_a', true)
  const targetsA = authorizedTargets(roster)
  check(
    'A1a 名单 = 三个目标 agent（无多无少）',
    targetsA.length === 3 && ['需求分析师', '挑战者', '会议记录官'].every((r) => targetsA.includes(r as never)),
    JSON.stringify(targetsA),
  )
  check('A1b 协调者在册也不进名单（调度者不可被调用）', !targetsA.includes('协调者' as never))
  check('A1c DRI / 成员不进名单（三个 AI 不参与轮值）', !targetsA.includes('DRI' as never))
  check('A1d isAuthorizedTarget(协调者) = false', isAuthorizedTarget('协调者', targetsA) === false)
  const targetsB = authorizedTargets(ctx.session.listMembers('s_b', true))
  check(
    'A1e 非 active 成员剔除 + 名册不全的名单 = [需求分析师]',
    targetsB.length === 1 && targetsB[0] === '需求分析师',
    JSON.stringify(targetsB),
  )

  // ── 二：大脑注册与未配置 ────────────────────────────────────────────────
  section('二：大脑注册与未配置（安全默认 = 暂停等人类）')
  const throwaway = new OrchestratorEngine(new Context())
  throwaway.registerBrain(scriptedBrain)
  try {
    throwaway.registerBrain(scriptedBrain)
    check('A2a 大脑重复注册即炸（duplicate_brain）', false, '没有抛错')
  } catch (e) {
    check(
      'A2a 大脑重复注册即炸（duplicate_brain）',
      e instanceof OrchestratorError && e.code === 'duplicate_brain',
      String((e as Error).message),
    )
  }
  // 主引擎还没注册大脑：Plan 触发 → 暂停、零调用、零猜测
  const r2 = await engine.onPlan(humanCommit(ctx, 's_a', '谁来看看这段日志？'))
  const t2 = engine.turn('s_a')
  check('A2b 未配置 → coordinator_unconfigured 暂停', r2?.case === 'coordinator_error' && t2.stopReason === 'coordinator_unconfigured', JSON.stringify(r2))
  check('A2c 未配置不计大脑调用（decisionCalls=0，承旧口径）', t2.decisionCalls === 0)
  check('A2d 状态回 static（静止即安全默认）', t2.state === 'static')
  check('A2e 广播 orchestrator/pause（铁律 2：暂停要可见）', pauseCount === 1 && lastPause?.stopReason === 'coordinator_unconfigured', JSON.stringify(lastPause))
  engine.registerBrain(scriptedBrain)

  // ── 三：名单外目标必拒 ────────────────────────────────────────────────
  section('三：名单外目标必拒（幻觉 / 越权 / 不在册）')
  const countBefore = ctx.eventLog.listBySession('s_a').length
  rawOut = JSON.stringify({ reply: '我让协调者自己看吧', reason: '认错人', delegate: { target: '协调者', instruction: '看看' } })
  const r3a = await engine.onPlan(humanCommit(ctx, 's_a', '帮我把日志理一理'))
  const t3a = engine.turn('s_a')
  check('A3a 委托协调者 → invalid_target 拒绝', r3a?.case === 'invalid_target', JSON.stringify(r3a))
  check('A3b 拒绝后暂停（invalid_target）', t3a.state === 'static' && t3a.stopReason === 'invalid_target')
  check('A3c 没有任何宣告（没有「将委托[」事件）', !ctx.eventLog.listBySession('s_a').some((e) => e.text.includes('将委托[')))
  rawOut = JSON.stringify({ reply: '', reason: '幻觉', delegate: { target: '评估师', instruction: '评一下' } })
  const r3b = await engine.onPlan(humanCommit(ctx, 's_a', '评估一下这个方案'))
  check('A3b2 幻觉目标「评估师」→ invalid_target', r3b?.case === 'invalid_target' && engine.turn('s_a').stopReason === 'invalid_target')
  rawOut = JSON.stringify({ reply: '叫挑战者来', reason: '', delegate: { target: '挑战者', instruction: '挑刺' } })
  const r3c = await engine.onPlan(humanCommit(ctx, 's_b', '挑挑毛病'))
  check('A3c 名册里没有的角色也拒（s_b 无挑战者）', r3c?.case === 'invalid_target')
  check(
    'A3d 拒绝分支仍给人类协调者回复（不静默）',
    ctx.eventLog.listBySession('s_a').length >= countBefore,
    `事件数 ${countBefore} → ${ctx.eventLog.listBySession('s_a').length}`,
  )

  // ── 四：NLP 判定口径（@ 只是提示，人类原话逐字透传）─────────────────────
  section('四：NLP 判定口径（不是字符串识别）')
  rawOut = '这个问题我先记下来，稍后给你边界分析。'
  await engine.onPlan(humanCommit(ctx, 's_a', '让需求分析师看看这段日志', ['a_analyst']))
  check('A4a 人类原话逐字透传给大脑（NLP 判定的输入）', lastReq?.humanText === '让需求分析师看看这段日志', JSON.stringify(lastReq?.humanText))
  check('A4b @ 提示透传（mentionHints）', JSON.stringify(lastReq?.mentionHints) === JSON.stringify(['a_analyst']))
  check('A4c 名单透传（三目标，不含协调者）', lastReq?.targets.length === 3 && !lastReq!.targets.includes('协调者' as never), JSON.stringify(lastReq?.targets))
  check('A4d 只有 @ 提及、大脑未判授权 → 仅商议后自然完成', engine.turn('s_a').state === 'static' && engine.turn('s_a').stopReason === 'completed')
  check('A4e 协调者的商议回复落了事件', lastEvent(ctx, 's_a')?.text === rawOut)

  // ── 五：合法委托与反馈暂停（回合状态机主干）─────────────────────────────
  section('五：合法委托 → 宣告 → 目标反馈 → 必须暂停')
  rawOut = JSON.stringify({ reply: '好的，这就叫分析师来', reason: '人类明确授权', delegate: { target: '需求分析师', instruction: '分析这段需求的边界条件' } })
  const trigger5 = humanCommit(ctx, 's_a', '需求分析师，分析这段需求的边界条件', ['a_analyst'])
  const r5 = await engine.onPlan(trigger5)
  const t5 = engine.turn('s_a')
  check('A5a 合法委托 → delegated', r5?.case === 'delegated' && r5.delegation?.target === '需求分析师', JSON.stringify(r5))
  const announce = lastEvent(ctx, 's_a')
  check(
    'A5b 调用前必须输出宣告（原文口径）',
    announce?.text.startsWith('已收到指令，将委托[需求分析师]：') === true && announce.authorKind === 'agent' && announce.authorId === 'a_coordinator',
    JSON.stringify(announce),
  )
  check('A5c 委托账本记账（单槽位）', JSON.stringify(t5.delegatedTargets) === JSON.stringify(['需求分析师']))
  check('A5d 每回合恰好一次大脑调用', t5.decisionCalls === 1)
  check('A5e 保持 chain 等目标反馈（不自动停也不自动续）', t5.state === 'chain')
  const foreignSource = ctx.eventLog.append({
    id: randomUUID(), sessionId: 's_b', authorId: 'u_dri', phaseId: null,
    authorKind: 'human', kind: 'message', text: '另一会话的长期记忆来源', mentions: [], toolCalls: [], replyMode: '',
  })
  const voidedSource = ctx.eventLog.append({
    id: randomUUID(), sessionId: 's_a', authorId: 'u_dri', phaseId: null,
    authorKind: 'human', kind: 'message', text: '当前会话中已撤回的记忆来源', mentions: [], toolCalls: [], replyMode: '',
  })
  ctx.eventLog.void(voidedSource.id, 'u_dri', 'verify invalid source')
  const fb = engine.reportFeedback('s_a', '需求分析师', '边界条件有三处，已列清单。', [foreignSource.id, voidedSource.id])
  check('A5f 反馈保留有效委托来源，不把跨会话或已撤回来源写入因果链',
    fb.authorKind === 'agent' && fb.authorId === 'a_analyst' && fb.text.includes('边界条件') &&
      fb.sourceEventId === trigger5.event.id && fb.sourceEventIds.includes(trigger5.event.id) &&
      !fb.sourceEventIds.includes(foreignSource.id) && !fb.sourceEventIds.includes(voidedSource.id) &&
      fb.replyTo == null, JSON.stringify(fb.sourceEventIds))
  const t5b = engine.turn('s_a')
  check('A5g 收到目标反馈后协调者自动续步，不强制等待人工', t5b.state === 'chain' || t5b.state === 'static' && t5b.stopReason !== 'await_human')
  check('A5h 自动续步留有第二次决策记录', t5b.decisionCalls >= 1)
  try {
    engine.reportFeedback('s_a', '会议记录官', '我没被委托过')
    check('A5i 未委托目标的反馈 → not_delegating', false, '没有抛错')
  } catch (e) {
    check('A5i 未委托目标的反馈 → not_delegating', e instanceof OrchestratorError && e.code === 'not_delegating', String((e as Error).message))
  }
  try {
    engine.reportFeedback('s_a', '需求分析师', '再说一遍')
    check('A5j 已暂停后反馈无处可交 → not_delegating', false, '没有抛错')
  } catch (e) {
    check('A5j 已暂停后反馈无处可交 → not_delegating', e instanceof OrchestratorError && e.code === 'not_delegating', String((e as Error).message))
  }

  // ── 六：三级兜底（policy 纯函数逐层对拍）───────────────────────────────
  section('六：三级兜底（parseCoordinatorOutput 纯函数）')
  const HUMAN = '需求分析师，分析这段需求的边界条件'
  const p0 = parseCoordinatorOutput(
    JSON.stringify({ reply: '收到', reason: '明确授权', delegate: { target: '需求分析师', instruction: '分析' } }),
    { humanText: HUMAN, targets: targetsA },
  )
  check('A6a 0 层：合法 JSON 直接采用、不警告', p0.level === 0 && !p0.warned && p0.decision.delegate?.target === '需求分析师', JSON.stringify(p0))
  const p1 = parseCoordinatorOutput('方案有两条路，各有取舍，我倾向第二条。', { humanText: HUMAN, targets: targetsA })
  check('A6b 1 层：纯文本无委托 → 整段只当回复', p1.level === 1 && !p1.warned && p1.decision.delegate === null && p1.decision.reply.includes('两条路'), JSON.stringify(p1))
  const p2a = parseCoordinatorOutput('{"reply": "叫记录官来", "target": "会议记录官", "instru', { humanText: HUMAN, targets: targetsA })
  check(
    'A6c 2 层：坏 JSON 正则救回 target → 补成委托',
    p2a.level === 2 && p2a.warned && p2a.decision.delegate?.target === '会议记录官' && p2a.decision.reply === '叫记录官来',
    JSON.stringify(p2a),
  )
  const p2b = parseCoordinatorOutput('{"reply": "这是纯商议的回复", "reas', { humanText: HUMAN, targets: targetsA })
  check('A6d 2 层：只救回 reply → 回复不委托', p2b.level === 2 && p2b.warned && p2b.decision.delegate === null && p2b.decision.reply.includes('纯商议'), JSON.stringify(p2b))
  const p3 = parseCoordinatorOutput('我将转达给需求分析师，请他开始分析。', { humanText: HUMAN, targets: targetsA })
  check(
    'A6e 3 层：明说「将转达」→ 补委托且 instruction = 人类原话',
    p3.level === 3 && p3.warned && p3.decision.delegate?.target === '需求分析师' && p3.decision.delegate.instruction === HUMAN,
    JSON.stringify(p3),
  )
  const pNeg = parseCoordinatorOutput('先不委托，我们只商议一下思路。', { humanText: HUMAN, targets: targetsA })
  check('A6f 负面语气护栏：不委托不报错（Warn 留原文）', pNeg.decision.delegate === null && pNeg.warned, JSON.stringify(pNeg))
  const pMulti = parseCoordinatorOutput('让需求分析师和挑战者都看看这个方案。', { humanText: HUMAN, targets: targetsA })
  check('A6g 多目标歧义护栏：单槽位不硬选', pMulti.decision.delegate === null && pMulti.warned, JSON.stringify(pMulti))
  const pEmpty = parseCoordinatorOutput('   ', { humanText: HUMAN, targets: targetsA })
  check('A6h 空输出护栏：不委托不报错（Warn 留原文）', pEmpty.decision.delegate === null && pEmpty.warned && pEmpty.decision.reply === '', JSON.stringify(pEmpty))
  const pDiscuss = parseCoordinatorOutput('我们先讨论一下需求背景再决定。', { humanText: HUMAN, targets: targetsA })
  check('A6i 「先讨论」→ 暂停语义（delegate null）', pDiscuss.decision.delegate === null, JSON.stringify(pDiscuss))
  const pOob = parseCoordinatorOutput(JSON.stringify({ reply: 'r', reason: '', delegate: { target: '评估师', instruction: 'x' } }), { humanText: HUMAN, targets: targetsA })
  check('A6j 解析器只转述不越权拒绝（名单裁决归引擎）', pOob.decision.delegate?.target === '评估师', JSON.stringify(pOob))

  // ── 七：兜底在引擎里的落点 ──────────────────────────────────────────────
  section('七：兜底在引擎里的落点（每回合恰好一次）')
  rawOut = '我先不委托，只商议。'
  await engine.onPlan(humanCommit(ctx, 's_a', '先聊聊'))
  check('A7a 负面语气 → 协调者回复并自然完成', engine.turn('s_a').stopReason === 'completed' && lastEvent(ctx, 's_a')?.text === rawOut)
  rawOut = ''
  const r7b = await engine.onPlan(humanCommit(ctx, 's_a', '空输出试试'))
  check('A7b 空输出 → coordinator_empty 暂停、零新事件', r7b?.case === 'coordinator_error' && engine.turn('s_a').stopReason === 'coordinator_empty')
  rawOut = '__THROW__'
  const r7c = await engine.onPlan(humanCommit(ctx, 's_a', '模型挂了试试'))
  check('A7c 大脑抛错 → coordinator_error（不猜不重试）', r7c?.case === 'coordinator_error' && engine.turn('s_a').decisionCalls === 1)
  rawOut = '我将转达给会议记录官。'
  const r7d = await engine.onPlan(humanCommit(ctx, 's_a', '会议记录官，把刚才的结论记下来'))
  check('A7d 3 层兜底在引擎里真委托', r7d?.case === 'delegated' && r7d.delegation?.instruction === '会议记录官，把刚才的结论记下来', JSON.stringify(r7d))
  check('A7e 每个新回合 decisionCalls 重开（恰好一次/回合）', engine.turn('s_a').decisionCalls === 1)
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— 对运行中的后端做接线断言（HTTP）
// ══════════════════════════════════════════════════════════════════════════
let S = ''
let authCookie = ''

async function post(text: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/sessions/${S}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authCookie },
    body: JSON.stringify({ text }),
  })
  const raw = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = { raw: raw.slice(0, 120) || '(空响应体)' }
  }
  return { status: res.status, body }
}

async function getTurn(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/sessions/${S}/turn`, { headers: { cookie: authCookie } })
  const raw = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = { raw: raw.slice(0, 120) || '(空响应体)' }
  }
  return { status: res.status, body }
}

async function getEvents(): Promise<Array<{ authorId?: string | null; text: string }>> {
  const res = await fetch(`${BASE}/api/sessions/${S}/events`, { headers: { cookie: authCookie } })
  if (!res.ok) return []
  return await res.json() as Array<{ authorId?: string | null; text: string }>
}

async function partB(): Promise<void> {
  section(`Part B：接线断言（${BASE}，会话 ${S}）`)

  let alive = false
  try {
    alive = (await fetch(`${BASE}/healthz`)).ok
  } catch {
    alive = false
  }
  check('B0 后端可达（/healthz）', alive, `连不上 ${BASE} —— 先 npm run start（verify 与 check:console 同前提）`)
  if (!alive) return

  const username = `verify_${Date.now()}`
  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'verify-pass-1' }),
  })
  if (registered.status !== 201) {
    check('B0a 可建立运行时验收 Team 账号', false, `HTTP ${registered.status}`)
    return
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'verify-pass-1' }),
  })
  authCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  if (!login.ok || !authCookie) {
    check('B0b 运行时验收账号登录并取得 Team cookie', false, `HTTP ${login.status}`)
    return
  }

  // The test account is deliberately not a member of the legacy demo session.
  // Create a private runtime fixture so this integration check exercises the
  // same invite-only access boundary as production sessions.
  S = `s_verify_orchestrator_${Date.now()}`
  const db = new DatabaseSync('data/database.db')
  const user = db.prepare('SELECT id, display_name FROM users WHERE username=?').get(username) as
    { id: string; display_name: string } | undefined
  if (!user) {
    db.close()
    check('B0c 可读取运行时验收账号身份', false)
    return
  }
  const now = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO sessions(id,title,current_phase,status,created_at,updated_at)
      VALUES (?, 'verify-orchestrator', NULL, 'open', ?, ?)`).run(S, now, now)
    db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
      VALUES (?, ?, '群主', 'active', ?, NULL, ?)`).run(S, user.id, now, user.display_name)
    const agents = [
      ['a_coordinator', '协调者', '协调者'],
      ['a_analyst', '成员', '需求分析师'],
    ] as const
    for (const [id, role, duty] of agents) {
      db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
        VALUES (?, ?, ?, 'active', ?, NULL, ?)`).run(S, id, role, now, duty)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
  check('B0c 为验收账号创建仅限成员访问的临时会话', true, S)

  // B1: @ 仍触发 Plan，但验收指令明确要求协调者直接结束，不派发后台
  // Agent 工作；这样 runtime gate 不会遗留真实模型驱动的长任务占用全局槽位。
  // Mention the coordinator itself: it is a valid trigger but deliberately not
  // a dispatch target, so this runtime check cannot accidentally start real
  // Agent work when a model treats an @Agent hint as a delegation request.
  const b1 = await post('@协调者 接线验收：请只回复“接线正常”，不要委托任何 Agent 执行任务。')
  check('B1a 接受已登录 Team 的 @ 提及消息', b1.status === 200, JSON.stringify(b1.body))
  let inboxPaused = false
  // Memory catch-up calls the configured LLM for each invited Agent. Allow the
  // same 60s ceiling as the runtime API instead of failing after an 8s test-only
  // window on a healthy but slower provider.
  const decisionDeadline = Date.now() + 60_000
  while (Date.now() < decisionDeadline) {
    const current = await getTurn()
    if (current.body.stopReason === 'completed' ||
      (current.body.state === 'static' && current.body.stopReason)) break
    const events = await getEvents()
    if (events.some((event) => event.text.includes('Agent 正在顺序处理更早的会话消息'))) {
      inboxPaused = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const t1 = await getTurn()
  check('B1b 大脑完成直接回复，或记忆屏障明确暂停且未越过顺序约束',
    (t1.status === 200 && t1.body.stopReason === 'completed' && t1.body.state === 'static') || inboxPaused,
    JSON.stringify({ turn: t1.body, inboxPaused }))
  // A configured-but-unreachable provider must leave a visible pause; it may
  // never skip memory sync or leave a chain with no live delegated work.
  check(
    'B1c 接线验收不派发 Agent 后台任务',
    (t1.body.stopReason === 'completed' && Array.isArray(t1.body.delegatedTargets) &&
      t1.body.delegatedTargets.length === 0) || inboxPaused,
    JSON.stringify({ turn: t1.body, inboxPaused }),
  )

  // 空消息应在消息入口被拒绝；并发中的 Agent 任务可能完成，故不拿整份回合快照
  // 与异步结束时间竞争。静态 verify-empty-message 独立断言不会 append 或 emit Plan。
  const empty = await post('   ')
  check('B2 空消息被拒绝', empty.status >= 400, JSON.stringify(empty.body))
  const events = await getEvents()
  check('B3 空消息不写入会话时间线', !events.some((event) => event.authorId === username && !event.text.trim()))
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const coreOnly = process.argv.includes('--core-only')
  console.log(`verify-orchestrator：P3 协作大脑端到端验收（APP_PORT=${PORT}）`)
  await partA()
  await verifyDecisionPause()
  await verifyCancelledDelegationLedger()
  await verifyDurableRecovery()
  await verifyOrphanedChainRecovery()
  await verifyConcurrentEngineRecovery()
  await verifyQueuedPlans()
  if (!coreOnly) await partB()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-orchestrator 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  const action = coreOnly ? 'verify-orchestrator-core' : 'verify-orchestrator'
  execFileSync(process.execPath, ['scripts/record-action.mjs', action, '{"ok":true}'], { stdio: 'inherit' })
  console.log(`✓ ${action} 全过（断言留痕：action_log: ${action}）`)
}

await main()
