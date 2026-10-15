// verify-workdir.ts —— P6 收尾验收（第十二门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑫ + P6 收尾拍板（2026-09-30）。
//   Part A（进程内，真 fs 但在临时目录）：space-workdir-local 五语义逐条对拍 ——
//     claim 幂等 / 未知 agent not_found（名册制：没入驻没有地盘）/
//     already_assigned / resolve 路径边界（root 内 OK、../ 逃逸、root2 前缀陷阱）
//     / release 清理（目录真删 + 再 get not_found）/ get|list 排序。
//     **红测**：SABOTAGE 探针（env 开关，非运行时行为）——
//     WORKDIR_SABOTAGE=1 时 LocalWorkdirService.resolve 走字符串 startsWith
//     弱判定（无路径边界），A3c root2 前缀陷阱必须判红；还原（不设该 env）
//     复绿。铁律要求断言「故意改坏会红」，本探针就是那个改坏形态。
//   Part B（进程内，编排委托全链）：scripted brain（承 verify-orchestrator 先例）
//     + 真 orchestrator + 真 agent-registry + 真 coder stub（订阅
//     'orchestrator/delegate'）+ 真 workdir（临时目录）：
//     /commit（staging/plan）→ 大脑委托「编码者」→ coder 认领 → 领工作区 →
//     任务文件落盘 → 状态机走满 → reportAgentResult 收执 → 回执落时间线
//     （authorKind=agent、authorId=agent.coder）→ 引擎处理结果回流。
//     另证：回执目标必须是当前会话已邀请的 Agent，
//     大脑未配置时 coordinator_unconfigured 暂停不变（诚实最小）。
//
// 用法：npm run verify:workdir    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-workdir（断言 ⑨）。
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { WorkdirError } from 'space-workdir'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { apply as applyAgentDispatcher } from '../plugins/agent-runtime-dispatcher/index.ts'
import { apply as runtimeApply } from '../packages/impl/space-agent-runtime/src/index.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteAgentCatalog } from '../packages/impl/space-store-sqlite/src/agent-catalog.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'
import { CommandService } from 'space-command'
import type { OrchestratorBrain, PlanRequest } from 'space-orchestrator'

// ── 断言器（与其他本地 verifier 同款）────────────────────────────────────────
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
async function expectWorkdirError(name: string, code: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn()
    check(name, false, `期望抛 ${code}，但没有抛`)
  } catch (e) {
    const got = e instanceof WorkdirError ? e.code : String((e as Error).message)
    check(name, got === code, `期望 ${code}，实际 ${got}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Part A —— space-workdir-local 五语义（临时目录真 fs）
// ══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  section('Part A：workdir 五语义（临时目录真 fs）' + (process.env.WORKDIR_SABOTAGE === '1' ? '【SABOTAGE 模式】' : ''))

  const tmp = mkdtempSync(join(tmpdir(), 'workdir-verify-'))
  const ctx = new Context()
  const agents = new AgentRegistry(ctx)
  agents.register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  const workdir = new LocalWorkdirService(ctx, tmp)

  // A1 未知 agent：名册制 —— 没入驻没有地盘
  await expectWorkdirError('A1a 未入驻 agent claim → not_found', 'not_found', () => workdir.claim('agent.nobody'))
  await expectWorkdirError('A1b 未领取 resolve → not_found', 'not_found', () => workdir.resolve('agent.coder', 'a.md'))

  let quotaCalls = 0
  const quotaFailCtx = new Context()
  new AgentRegistry(quotaFailCtx).register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  const quotaFail = new LocalWorkdirService(quotaFailCtx, join(tmp, 'quota-fail'), {
    required: true,
    ensure: async () => { quotaCalls++; throw new Error('simulated host quota failure') },
  })
  await expectWorkdirError('A1c 配额登记失败时拒绝创建工作区', 'quota_unavailable', () => quotaFail.claim('agent.coder'))
  check('A1d 配额失败发生在目录创建前', quotaCalls === 1 && !existsSync(join(tmp, 'quota-fail', 'workdirs', 'agent.coder')))
  const quotaPassCtx = new Context()
  new AgentRegistry(quotaPassCtx).register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  const quotaPass = new LocalWorkdirService(quotaPassCtx, join(tmp, 'quota-pass'), {
    required: true, ensure: async () => { quotaCalls++ },
  })
  await quotaPass.claim('agent.coder')
  check('A1e 配额成功后才创建工作区', quotaCalls === 2 && existsSync(join(tmp, 'quota-pass', 'workdirs', 'agent.coder')))
  const helperCtx = new Context()
  new AgentRegistry(helperCtx).register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  const helperPath = join(tmp, 'fake-quota-helper.mjs')
  const helperLog = join(tmp, 'fake-quota-helper.log')
  writeFileSync(helperPath, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nif (process.argv[2] !== 'ensure' || process.argv[3] !== 'agent.coder') process.exit(23)\nappendFileSync(${JSON.stringify(helperLog)}, process.argv.slice(2).join(' ') + '\\n')\n`)
  chmodSync(helperPath, 0o755)
  const previousHelper = process.env.WORKDIR_QUOTA_HELPER
  const previousSudo = process.env.WORKDIR_QUOTA_SUDO
  process.env.WORKDIR_QUOTA_HELPER = helperPath
  delete process.env.WORKDIR_QUOTA_SUDO
  const helperWorkdir = new LocalWorkdirService(helperCtx, join(tmp, 'helper-backed'), { required: true })
  await helperWorkdir.claim('agent.coder')
  check('A1f 配额助手收到固定 ensure + Agent ID 参数', readFileSync(helperLog, 'utf8').trim() === 'ensure agent.coder')
  if (previousHelper === undefined) delete process.env.WORKDIR_QUOTA_HELPER
  else process.env.WORKDIR_QUOTA_HELPER = previousHelper
  if (previousSudo === undefined) delete process.env.WORKDIR_QUOTA_SUDO
  else process.env.WORKDIR_QUOTA_SUDO = previousSudo
  const missingHelperCtx = new Context()
  new AgentRegistry(missingHelperCtx).register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  delete process.env.WORKDIR_QUOTA_HELPER
  const missingHelper = new LocalWorkdirService(missingHelperCtx, join(tmp, 'helper-missing'), { required: true })
  await expectWorkdirError('A1g 配额必需但未配置助手时拒绝 claim', 'quota_unavailable', () => missingHelper.claim('agent.coder'))
  check('A1h 助手缺失时没有创建目录', !existsSync(join(tmp, 'helper-missing', 'workdirs', 'agent.coder')))
  if (previousHelper !== undefined) process.env.WORKDIR_QUOTA_HELPER = previousHelper

  // A2 claim 幂等 + root 形状
  const h1 = await workdir.claim('agent.coder')
  const h2 = await workdir.claim('agent.coder')
  check('A2a claim 幂等（同 agentId 同 handle）', h1 === h2 && h1.agentId === 'agent.coder')
  check('A2b root 形状 = <tmp>/workdirs/agent.coder', h1.root === join(tmp, 'workdirs', 'agent.coder'), h1.root)
  check('A2c 目录真的建出来了', existsSync(h1.root))
  check('A2e claim 建立项目/任务/脚本/笔记分区',
    ['projects', 'tasks', 'scripts', 'notes'].every((name) => existsSync(join(h1.root, name))))
  check('A2d list 按 agentId 排序', workdir.list().length === 1 && workdir.list()[0]!.agentId === 'agent.coder')

  // A2f team file handoff: real filesystem copy, no overwrite, and secret-path guard.
  agents.register({ id: 'agent.other', kind: 'coding', title: '另一个', capabilities: ['coding'] })
  const transferSource = join(h1.root, 'notes', 'handoff.ts')
  writeFileSync(transferSource, 'export const answer = 42\n')
  await workdir.writeFile({ kind: 'agent', agentId: 'agent.coder' }, 'projects/upload.bin', new Uint8Array([0, 1, 127, 255]))
  check('A2f1 上传保留任意二进制字节', Buffer.from(await workdir.readFile({ kind: 'agent', agentId: 'agent.coder' }, 'projects/upload.bin')).equals(Buffer.from([0, 1, 127, 255])))
  let uploadConflict = ''
  try { await workdir.writeFile({ kind: 'agent', agentId: 'agent.coder' }, 'projects/upload.bin', new Uint8Array([9])) }
  catch (error) { uploadConflict = (error as Error).message }
  check('A2f2 上传同名文件拒绝覆盖', uploadConflict.includes('未覆盖') && Buffer.from(readFileSync(join(h1.root, 'projects', 'upload.bin'))).equals(Buffer.from([0, 1, 127, 255])))
  await workdir.writeFile({ kind: 'shared' }, 'incoming/交接.bin', new Uint8Array([2, 3, 4]))
  check('A2f3 上传支持共享工作区和中文文件名', Buffer.from(await workdir.readFile({ kind: 'shared' }, 'incoming/交接.bin')).equals(Buffer.from([2, 3, 4])))
  let secretUploadRejected = false
  try { await workdir.writeFile({ kind: 'shared' }, '.env', new Uint8Array([1])) }
  catch { secretUploadRejected = true }
  check('A2f4 上传禁止写入凭据路径', secretUploadRejected)
  let uploadTraversalRejected = false
  try { await workdir.writeFile({ kind: 'shared' }, '../outside.txt', new Uint8Array([1])) }
  catch { uploadTraversalRejected = true }
  check('A2f5 上传路径不能越出工作区', uploadTraversalRejected && !existsSync(join(tmp, 'outside.txt')))
  await workdir.copyFile({ kind: 'agent', agentId: 'agent.coder' }, 'notes/handoff.ts', { kind: 'agent', agentId: 'agent.other' })
  const transferredPath = join(tmp, 'workdirs', 'agent.other', 'handoff.ts')
  check('A2f Agent 文件可复制到另一工作区且内容一致', existsSync(transferredPath) && readFileSync(transferredPath, 'utf8') === 'export const answer = 42\n')
  await workdir.copyFile({ kind: 'agent', agentId: 'agent.coder' }, 'notes/handoff.ts', { kind: 'shared' })
  check('A2g Agent 文件可复制到公共工作区', readFileSync(join(tmp, 'shared-workspace', 'handoff.ts'), 'utf8') === 'export const answer = 42\n')
  await workdir.copyFile({ kind: 'shared' }, 'handoff.ts', { kind: 'agent', agentId: 'agent.coder' })
  check('A2g2 公共工作区文件可复制回 Agent 工作区', readFileSync(join(h1.root, 'handoff.ts'), 'utf8') === 'export const answer = 42\n')
  let transferConflict = ''
  try { await workdir.copyFile({ kind: 'agent', agentId: 'agent.coder' }, 'notes/handoff.ts', { kind: 'agent', agentId: 'agent.other' }) }
  catch (error) { transferConflict = (error as Error).message }
  check('A2h 同名目标拒绝覆盖并说明原因', transferConflict.includes('未覆盖'))
  let secretTransferRejected = false
  try { await workdir.copyFile({ kind: 'agent', agentId: 'agent.coder' }, 'notes/.env', { kind: 'shared' }) }
  catch { secretTransferRejected = true }
  check('A2i 敏感文件禁止工作区互传', secretTransferRejected)

  // A3 resolve：路径边界判定（execdir 铁则）
  const inside = workdir.resolve('agent.coder', 'sub/dir/task.md')
  check('A3a root 内相对路径解析通过', inside.startsWith(h1.root))
  check('A3b 「.」解析为 root 本身', workdir.resolve('agent.coder', '.') === h1.root)
  // ①../ 上跳：归一化后跑到 root 外（强弱判定都拦 —— 基线逃逸必须拦住）
  await expectWorkdirError('A3c-1 ../ 上跳逃逸 → path_escape', 'path_escape', () =>
    workdir.resolve('agent.coder', '../../escape/x.md'))
  // ②「root 同名字符串前缀」陷阱：相对路径折返拼出 <root>2/x —— 以 root
  //   字符串开头但在 root 之外。强判定（root + sep 边界）必拦；
  //   SABOTAGE 弱判定（裸 startsWith）放行不抛 —— 红测靶子（改坏会红）。
  const prefixTrap = '../' + h1.root.split('/').pop() + '2/x.md'
  const trapped = (() => {
    try {
      workdir.resolve('agent.coder', prefixTrap)
      return false // 放行了（弱判定盲区）
    } catch (e) {
      return e instanceof WorkdirError && e.code === 'path_escape'
    }
  })()
  check('A3c-2 root 同名前缀陷阱被边界判定拦截', trapped,
    `trap=${prefixTrap}；被拦=${trapped}（SABOTAGE 弱判定下应 false → 判红）`)
  await expectWorkdirError('A3d 绝对路径输入同样受边界判定', 'path_escape', () =>
    workdir.resolve('agent.coder', join(tmpdir(), 'outside.md')))

  // A4 release 清理
  await workdir.release('agent.coder')
  check('A4a release 后目录真删', !existsSync(h1.root))
  await expectWorkdirError('A4b release 后 get → not_found', 'not_found', () => workdir.get('agent.coder'))
  await expectWorkdirError('A4c 重复 release → not_found', 'not_found', () => workdir.release('agent.coder'))

  // A5 already_assigned：同一路径被别的 agent 登记（篡改台账模拟归属冲突）。
  // 注意 registry 与 workdir 必须同 ctx（claim 查 this.ctx.agents）。
  const ctx2 = new Context()
  const agents2 = new AgentRegistry(ctx2)
  agents2.register({ id: 'agent.coder', kind: 'coding', title: '编码者', capabilities: ['coding'] })
  agents2.register({ id: 'agent.other', kind: 'coding', title: '另一个', capabilities: ['coding'] })
  const workdir2 = new LocalWorkdirService(ctx2, tmp)
  const coderHandle = await workdir2.claim('agent.coder')
  // 篡改台账：预置一条「other 已登记在 coder 的 root 上」的记录，
  // 再 claim('agent.coder')？不行 —— coder 已在台账。改为：把 coder 从台账移除，
  // 留下 other 占着 coder 的 root，然后 claim('agent.coder') → rootOf 相同 → 冲突。
  const handles = (workdir2 as unknown as { handles: Map<string, { agentId: string; root: string; createdAt: number }> }).handles
  handles.delete('agent.coder')
  handles.set('agent.other', { agentId: 'agent.other', root: coderHandle.root, createdAt: 0 })
  await expectWorkdirError('A5 root 被别的 agent 占用 → already_assigned', 'already_assigned', () =>
    workdir2.claim('agent.coder'))
  rmSync(tmp, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— 编排委托全链（scripted brain → coder 认领 → workdir 落盘 → 收执）
// ══════════════════════════════════════════════════════════════════════════
async function partB(): Promise<void> {
  section('Part B：编排委托全链（scripted brain → coder 领地落盘 → 收执暂停）')

  const tmp = mkdtempSync(join(tmpdir(), 'workdir-chain-'))
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
  insSession.run('s_w', '验收（委托链）', t, t)
  for (const [pid, role] of [
    ['u_dri', 'DRI'],
    ['a_coordinator', '协调者'],
    ['a_analyst', '需求分析师'],
    ['a_recorder', '会议记录官'],
  ] as const) {
    insMember.run('s_w', pid, role, t)
  }

  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqliteEventLog(ctx, db)
  const catalog = new SqliteAgentCatalog(ctx, db)
  Object.assign(ctx, { agentCatalog: catalog })
  const agents = new AgentRegistry(ctx)
  agents.bindCatalog(catalog)
  new CommandService(ctx) // ctx.commands（stub apply 要注册 /tell）
  const workdir = new LocalWorkdirService(ctx, tmp) // ctx.workdir
  const engine = new OrchestratorEngine(ctx) // ctx.orchestrator

  // Catalog definition + generic dispatcher exercise the current production path.
  runtimeApply(ctx)
  applyAgentDispatcher(ctx)
  ctx.session.join({ sessionId: 's_w', principalId: 'agent.coder', role: '成员', duty: '编码者' })

  // scripted brain（承 verify-orchestrator 先例）：可编程的"模型"
  let rawOut = ''
  let lastReq: PlanRequest | null = null
  const brain: OrchestratorBrain = {
    async plan(req) {
      lastReq = req
      return rawOut
    },
  }
  engine.registerBrain(brain)

  function humanCommit(text: string) {
    const event = ctx.eventLog.append({
      id: randomUUID(),
      sessionId: 's_w',
      authorId: 'u_dri',
      phaseId: null,
      authorKind: 'human',
      kind: 'message',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
    ctx.emit('staging/plan', { sessionId: 's_w', authorId: 'u_dri', event })
    return event
  }

  // B1 授权名单包含当前会话成员与已加入会话的目录 Agent。
  rawOut = JSON.stringify({ reply: '', reason: '', delegate: { target: '编码者', instruction: '实现登录页' } })
  const ev1 = humanCommit('@编码者 实现登录页')
  await engine.onPlan({ sessionId: 's_w', authorId: 'u_dri', event: ev1 })
  check('B1a 大脑 targets 含已加入会话的目录 Agent（编码者）', lastReq!.targets.includes('编码者'), JSON.stringify(lastReq!.targets))
  check('B1b targets 同时含会议角色（开会链路不回退）', lastReq!.targets.includes('会议记录官'), JSON.stringify(lastReq!.targets))
  check('B1c catalog Agent 作为显式会话成员入册',
    ctx.session.listMembers('s_w', true).some((m) => m.principalId === 'agent.coder' && m.role === '成员'))
  // 认领是异步（事件总线），等事件循环排空
  await new Promise((r) => setTimeout(r, 50))
  const evs1 = ctx.eventLog.listBySession('s_w')
  const receipt = evs1.find((e) => e.authorId === 'agent.coder' && e.authorKind === 'agent')
  check('B2 回执落时间线（authorId=agent.coder, kind=agent）', !!receipt, JSON.stringify(evs1.map((e) => [e.authorId, e.authorKind])))
  check('B3 回执含工作区绝对路径 + 产物清单', !!receipt && receipt.text.includes('【工作区】') && receipt.text.includes('【产物清单】'), receipt?.text)
  const rootOf = receipt?.text.match(/【工作区】(.+)/)?.[1] ?? ''
  check('B4 工作区目录真的存在（claim 建区）', !!rootOf && existsSync(rootOf), rootOf)
  const taskFiles = rootOf && existsSync(join(rootOf, 'tasks'))
    ? readdirSync(join(rootOf, 'tasks')).flatMap((directory) => {
      const taskPath = join(rootOf, 'tasks', directory, 'task.md')
      return existsSync(taskPath) ? [taskPath] : []
    }) : []
  check('B5 任务文件按轮次存入 tasks/<run>/task.md（内容含指令）', taskFiles.length === 1 &&
    readFileSync(taskFiles[0]!, 'utf8').includes('实现登录页'), JSON.stringify(taskFiles))
  check('B6 状态机走满一圈（回 idle，可领下一个）', ctx.agents.get('agent.coder').status === 'idle')
  const turn = engine.turn('s_w')
  check('B7 收执后引擎允许按自治策略继续（不强制 await_human）', turn.stopReason !== 'await_human', JSON.stringify(turn))
  check('B8 收执事件点名 coder 已交付', evs1.some((e) => e.authorId === 'agent.coder' && e.text.includes('已领任务')), JSON.stringify(evs1.map((e) => e.text)))
  check('B9 协调者宣告先于委托（时间线可见）', evs1.some((e) => e.authorId === 'a_coordinator' && e.text.includes('将委托[编码者]')))

  // B10 Agent target can only settle its own active delegation once.
  rawOut = JSON.stringify({ reply: '', reason: '', delegate: { target: '编码者', instruction: '第二单' } })
  const ev2 = humanCommit('再来一单')
  await engine.onPlan({ sessionId: 's_w', authorId: 'u_dri', event: ev2 })
  await new Promise((r) => setTimeout(r, 50))
  let fbThrew = ''
  try {
    engine.reportFeedback('s_w', '编码者', '不该成功')
    fbThrew = '没有抛'
  } catch (e) {
    fbThrew = e instanceof Error && e.name === 'OrchestratorError' ? 'OrchestratorError' : String(e)
  }
  check('B10 已结算委托不能通过另一回执重复结账', fbThrew === 'OrchestratorError', fbThrew)
  // 收执口正常结账；连续主动回复由系统拦截并留可见事件。
  const ev3 = ctx.eventLog.listBySession('s_w').find((e) => e.text.includes('尝试主动发言，但是被拦截'))
  check('B11 连续主动发言被拦截并留会话事件', !!ev3 && ev3.authorKind === 'system', ev3?.text)
  check('B12 交付后不强制 await_human', engine.turn('s_w').stopReason !== 'await_human')

  // B13 大脑未配置：诚实最小 + 文案点明委托回路就绪
  const ctx3 = new Context()
  new SqliteSessionStore(ctx3, db)
  new SqliteEventLog(ctx3, db)
  new AgentRegistry(ctx3) // planOnce resolves Agent targets through the shared catalog.
  const engine3 = new OrchestratorEngine(ctx3)
  const ev4 = ctx3.eventLog.append({
    id: randomUUID(), sessionId: 's_w', authorId: 'u_dri', phaseId: null,
    authorKind: 'human', kind: 'message', text: '你好', mentions: [], toolCalls: [], replyMode: '',
  })
  await engine3.onPlan({ sessionId: 's_w', authorId: 'u_dri', event: ev4 })
  const t3 = engine3.turn('s_w')
  check('B13 无大脑 coordinator_unconfigured 暂停不变（文案点明委托回路就绪）',
    t3.state === 'static' && t3.stopReason === 'coordinator_unconfigured' && t3.stopDetail.includes('委托回路已就绪'), JSON.stringify(t3))

  rmSync(tmp, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(`verify-workdir：P6 收尾验收（workdir 五语义 + coding 委托闭环；断言 ⑫）`)
  await partA()
  await partB()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-workdir 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  // 留痕（断言 ⑨）：直接写 action_log（与 record-action.mjs 同一 INSERT 形状；
  // 不走子进程 —— tsx 环境下 execFileSync 会踩 Windows shim，实测拉起 cmd.exe）
  const dbPath = process.cwd() + '/data/database.db'
  if (existsSync(dbPath)) {
    const log = new DatabaseSync(dbPath)
    const has = log.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='action_log'`).get()
    if (has.n) {
      log.prepare(`INSERT INTO action_log(action, detail, ok, created_at) VALUES (?, ?, 1, ?)`)
        .run('verify-workdir', '{"ok":true}', new Date().toISOString())
      console.log('· 留痕：verify-workdir → action_log')
    }
    log.close()
  }
  console.log('✓ verify-workdir 全过（断言留痕：action_log: verify-workdir）')
}

await main()
