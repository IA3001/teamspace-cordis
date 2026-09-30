// verify-orchestrator.ts —— P3 端到端验收（第八门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 5 节 P3 行 + 第 7 节待定 5（可断言子集）。
//   Part A（进程内，桩大脑离线重放 —— 旧 Coordinator interface 的门禁口径）：
//     授权名单（三目标 agent、协调者不在册、非 active 剔除）、名单外必拒、
//     未注册大脑 → 暂停、每回合恰好一次决策、NLP 判定口径（@ 只是提示、
//     人类原话逐字透传）、三级兜底（policy 纯函数逐层对拍 + 引擎落点）、
//     负面语气/多目标/空输出护栏、收到目标反馈后必须暂停（await_human）。
//   Part B（对运行中的后端）：接线 —— /commit 触发 'staging/plan' 后
//     orchestrator 确实接管（回合存在、每回合恰好一次、无大脑 → 暂停），
//     经 GET /api/sessions/:id/turn 只读口观测。
//
// 前提：后端已在 APP_PORT 运行（与 verify:staging 同前提，gate 顺序保证）。
// 用法：npm run verify:orchestrator    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-orchestrator（断言 ⑨）。
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import type { PlanRequest } from 'space-orchestrator'
import { OrchestratorError } from 'space-orchestrator'
import { authorizedTargets, isAuthorizedTarget, parseCoordinatorOutput } from 'space-authz'
import type { OrchestratorBrain } from 'space-orchestrator'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'

// ── 断言器（与 verify-staging 同款）────────────────────────────────────────
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

// ── 端口：.env 唯一出处（与 verify-staging 同源）──────────────────────────
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
  // 主引擎还没注册大脑：/commit 触发 Plan → 暂停、零调用、零猜测
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
  check('A4d 只有 @ 提及、大脑未判授权 → 不委托（replied）', engine.turn('s_a').state === 'static' && engine.turn('s_a').stopReason === 'await_human')
  check('A4e 协调者的商议回复落了事件', lastEvent(ctx, 's_a')?.text === rawOut)

  // ── 五：合法委托与反馈暂停（回合状态机主干）─────────────────────────────
  section('五：合法委托 → 宣告 → 目标反馈 → 必须暂停')
  rawOut = JSON.stringify({ reply: '好的，这就叫分析师来', reason: '人类明确授权', delegate: { target: '需求分析师', instruction: '分析这段需求的边界条件' } })
  const r5 = await engine.onPlan(humanCommit(ctx, 's_a', '需求分析师，分析这段需求的边界条件', ['a_analyst']))
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
  const fb = engine.reportFeedback('s_a', '需求分析师', '边界条件有三处，已列清单。')
  check('A5f 反馈落为该 agent 的发言事件', fb.authorKind === 'agent' && fb.authorId === 'a_analyst' && fb.text.includes('边界条件'))
  const t5b = engine.turn('s_a')
  check('A5g 收到目标反馈后必须暂停（await_human）—— 铁律执行点', t5b.state === 'static' && t5b.stopReason === 'await_human')
  check('A5h 暂停广播可达（观测点）', lastPause?.stopReason === 'await_human' && lastPause.stopDetail.includes('等待人类'))
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
  check('A7a 负面语气 → 协调者回复 + await_human', engine.turn('s_a').stopReason === 'await_human' && lastEvent(ctx, 's_a')?.text === rawOut)
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
const S = 's_seed_demo'
const U = 'u_dri'

async function post(text: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/sessions/${S}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, authorId: U }),
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
  const res = await fetch(`${BASE}/api/sessions/${S}/turn`)
  const raw = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = { raw: raw.slice(0, 120) || '(空响应体)' }
  }
  return { status: res.status, body }
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

  // B1 /commit → 'staging/plan' → orchestrator 接管。
  // P8 口径修订（2026-09-30）：服务端现已注册**占位大脑**（plugins/brain-stub，
  // 组合根常驻）—— /commit 触发恰好一次大脑调用；本轮无 @ 命中 → 分支二纯文本
  // 回复 → await_human 暂停。「未配置大脑 → coordinator_unconfigured」的承旧
  // 口径改由两处继续承担：Part A（进程内真引擎无大脑）+ verify-p8 B4（brain-stub
  // config.enabled=false 的组合根关断路径）—— 保护力不丢，落点搬家。
  await post('/clear confirm')
  await post('/add p3-wiring-one')
  const b1 = await post('/commit')
  check('B1a /commit 依旧 200（接缝无回归）', b1.status === 200, JSON.stringify(b1.body))
  const t1 = await getTurn()
  check('B1b orchestrator 已接管：回合存在（GET /turn）', t1.status === 200 && typeof t1.body.decisionCalls === 'number', JSON.stringify(t1))
  check(
    'B1c 占位大脑上线 → 每回合恰好一次调用 + await_human 暂停（P8 起）',
    t1.body.decisionCalls === 1 && t1.body.stopReason === 'await_human' && t1.body.state === 'static',
    JSON.stringify(t1.body),
  )

  // B2 第二次提交：新回合重开（每回合记账重开 —— P8 下每回合各计 1 次调用）
  await post('/add p3-wiring-two')
  await post('/commit')
  const t2 = await getTurn()
  check('B2 新回合重开（decisionCalls 按回合重新记账）', t2.body.decisionCalls === 1 && t2.body.stopReason === 'await_human', JSON.stringify(t2.body))

  // B3 空 /commit：零事件零信号 → 回合纹丝不动（P2 语义经 orchestrator 仍成立）
  const t2snap = JSON.stringify(t2.body)
  await post('/commit')
  const t3 = await getTurn()
  check('B3 空 /commit 不触发 Plan（回合不变）', JSON.stringify(t3.body) === t2snap, `${t2snap} → ${JSON.stringify(t3.body)}`)
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(`verify-orchestrator：P3 协作大脑端到端验收（APP_PORT=${PORT}）`)
  await partA()
  await partB()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-orchestrator 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-orchestrator', '{"ok":true}'], { stdio: 'inherit' })
  console.log('✓ verify-orchestrator 全过（断言留痕：action_log: verify-orchestrator）')
}

await main()
