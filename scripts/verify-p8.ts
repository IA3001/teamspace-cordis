// verify-p8.ts —— P8 机制层验收（第十三门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑬ + P8 拍板（2026-09-30）。
//   Part A（进程内，:memory: 真库）：ctx.prompts 三语义逐条对拍 —— get 未知
//     not_found / upsert 幂等键（同 ref 整替换、ref 不变）/ 三要素空白
//     invalid_input / list 按 ref 稳定排序 / seed 0002 四条占位与幂等。
//   Part B（进程内，编排全链）：**占位大脑两分支决策形状** —— 真引擎 +
//     真 brain-stub 插件（apply 原样）+ 真三 stub + 真名册 + 真 prompts：
//     分支一 @ 提示命中 → 合法 JSON 委托（instruction=人类原话）+ 宣告带
//     「大脑附言」明示占位；分支二未命中 → 纯文本回复不委托（明示占位）；
//     文案处处带「占位大脑（非 NLP，等待模型 key）」标记；config.enabled=false
//     → 回 coordinator_unconfigured 安全默认。
//     **红测**：BRAIN_SABOTAGE=1（brain-stub 内置探针）—— 未命中也吐委托
//     JSON，分支二断言必红；还原（不设 env）复绿。铁律要求断言「故意改坏
//     会红」，本探针就是那个改坏形态（自检记录见文末）。
//   Part C（进程内，建会名册）：createSessionWithRoster（服务端建会与 RPC
//     同一条代码路径）—— 默认名册 6 席（DRI + 协调者 + 会议三机器人，补
//     P7 遗留 1）+ coding 多选入会（role=成员、duty=名册 title）+ 名册外
//     id 忽略 + promptRef 绑定闭环（三 stub 的 promptRef 全部能在
//     prompt_templates 里取到内容）。
//   Part D（进程内，双 stub 入驻 ⑪ 回归）：三 coding stub 同场 —— 名册形状
//     （id 排序 / title / promptRef / capabilities / 报到即 idle）+ 委托定向性
//     （委托「测试者」只有 tester 回执，coder/reviewer 静默）+ /tell 直派
//     测试者走共享干活路径。⑪ 的白名单静态扫描由 gate 链里 verify:agents
//     Part C 承担（verify-p8.ts 已进其白名单，同 verify-workdir 待遇）。
//
// 用法：npm run verify:p8    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-p8（断言 ⑨；内联直写 ——
// tsx 下 execFileSync 会踩 Windows shim，承 verify-workdir 实测教训）。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { PromptError } from 'space-prompt'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqlitePromptStore } from '../packages/impl/space-store-sqlite/src/prompt.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { apply as runtimeApply } from '../packages/impl/space-agent-runtime/src/index.ts'
import { apply as coderApply } from '../plugins/agent-coder-stub/index.ts'
import { apply as testerApply } from '../plugins/agent-tester-stub/index.ts'
import { apply as reviewerApply } from '../plugins/agent-reviewer-stub/index.ts'
import { apply as brainApply } from '../plugins/brain-stub/index.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'
import { createSessionWithRoster } from '../packages/client-ui/space-client-ui-sessions/src/index.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'
import { CommandService, parse } from 'space-command'
import type { CommandCtx } from 'space-command'

// ── 断言器（与 verify-workdir 同款）────────────────────────────────────────
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
async function expectPromptError(name: string, code: string, fn: () => unknown): Promise<void> {
  try {
    await fn()
    check(name, false, `期望抛 ${code}，但没有抛`)
  } catch (e) {
    const got = e instanceof PromptError ? e.code : String((e as Error).message)
    check(name, got === code, `期望 ${code}，实际 ${got}`)
  }
}

/** ：memory: 真库 + 全迁移 + 种子（prompt 4 条 + 演示会话），返回 db。 */
function memoryDb(withSeed: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
  for (const m of loadMigrations(migrationsDir)) db.exec(m.up)
  if (withSeed) {
    const seedDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/seed/', import.meta.url))
    for (const f of readdirSync(seedDir).filter((x) => x.endsWith('.sql')).sort()) {
      db.exec(readFileSync(join(seedDir, f), 'utf8'))
    }
  }
  return db
}

// ══════════════════════════════════════════════════════════════════════════
// Part A —— ctx.prompts 三语义 + seed 占位（seam 契约照表执法）
// ══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  section('Part A：提示词语义（get / upsert / list + seed 占位）')

  const db = memoryDb(false)
  const ctx = new Context()
  const prompts = new SqlitePromptStore(ctx, db)

  // A1 get 未知 → not_found
  await expectPromptError('A1 get 未知 ref → not_found', 'not_found', () => prompts.get('prompt.nobody'))

  // A2 upsert 新 ref + 返回模板
  const t1 = prompts.upsert('prompt.demo', '演示提示词', '第一版正文')
  check('A2a upsert 新 ref 返回模板', t1.ref === 'prompt.demo' && t1.title === '演示提示词' && t1.body === '第一版正文')
  check('A2b updatedAt 是 ISO 时刻', !Number.isNaN(new Date(t1.updatedAt).getTime()), t1.updatedAt)

  // A3 upsert 幂等键：同 ref 整替换（title/body 换，ref 不变）
  const t2 = prompts.upsert('prompt.demo', '演示提示词 v2', '第二版正文')
  check('A3a 同 ref upsert 整替换正文', t2.title === '演示提示词 v2' && t2.body === '第二版正文' && t2.ref === 'prompt.demo')
  check('A3b updatedAt 前进（内容资产的新鲜度可见）', t2.updatedAt >= t1.updatedAt, `${t1.updatedAt} → ${t2.updatedAt}`)
  check('A3c 不产生重复行（ref 是主键）', prompts.list().filter((x) => x.ref === 'prompt.demo').length === 1)

  // A4 三要素空白 → invalid_input
  await expectPromptError('A4a ref 空白 → invalid_input', 'invalid_input', () => prompts.upsert('  ', 't', 'b'))
  await expectPromptError('A4b title 空白 → invalid_input', 'invalid_input', () => prompts.upsert('r', '', 'b'))
  await expectPromptError('A4c body 空白 → invalid_input', 'invalid_input', () => prompts.upsert('r', 't', '  '))

  // A5 list 按 ref 稳定排序
  const refs = prompts.list().map((x) => x.ref)
  check('A5 list 按 ref 稳定排序', refs.join(',') === [...refs].sort().join(','), refs.join(','))

  // A6 seed 0002：四条占位 + 幂等 + 文案明示待原文
  const seedDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/seed/', import.meta.url))
  db.exec(readFileSync(join(seedDir, '0002_svc_prompt.sql'), 'utf8'))
  const seeded = prompts.list()
  check('A6a seed 落 4 条占位（角色 1~4）',
    ['prompt.minutes', 'prompt.coding', 'prompt.testing', 'prompt.review'].every((r) => seeded.some((x) => x.ref === r)),
    JSON.stringify(seeded.map((x) => x.ref)))
  const SEEDED_REFS = ['prompt.minutes', 'prompt.coding', 'prompt.testing', 'prompt.review']
  check('A6b 占位文案明示「待原文」与「占位」',
    seeded.filter((x) => SEEDED_REFS.includes(x.ref)).every((x) => x.body.includes('占位提示词') && x.body.includes('原文')))
  const before = seeded.length
  db.exec(readFileSync(join(seedDir, '0002_svc_prompt.sql'), 'utf8'))
  check('A6c seed 重播幂等（INSERT OR IGNORE）', prompts.list().length === before)
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— 占位大脑两分支决策形状（真引擎 + 真 brain-stub 插件）
// ══════════════════════════════════════════════════════════════════════════
function humanCommit(ctx: Context, sessionId: string, authorId: string, text: string, mentions: string[] = []) {
  const event = ctx.eventLog.append({
    id: randomUUID(),
    sessionId,
    authorId,
    phaseId: null,
    authorKind: 'human',
    kind: 'message',
    text,
    mentions,
    toolCalls: [],
    replyMode: '',
  })
  ctx.emit('staging/plan', { sessionId, authorId, event })
  return event
}

async function partB(): Promise<void> {
  section('Part B：占位大脑两分支决策形状' + (process.env.BRAIN_SABOTAGE === '1' ? '【SABOTAGE 模式】' : ''))

  const tmp = mkdtempSync(join(tmpdir(), 'p8-brain-'))
  const db = memoryDb(true)
  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqliteEventLog(ctx, db)
  new SqlitePromptStore(ctx, db) // promptRef 绑定的内容源（seed 已入）
  new AgentRegistry(ctx)
  new CommandService(ctx)
  new LocalWorkdirService(ctx, tmp)
  const engine = new OrchestratorEngine(ctx)
  // 真插件原样 apply：三 stub 入驻 + 共享干活路径 + 占位大脑注册。
  runtimeApply(ctx)
  coderApply(ctx)
  testerApply(ctx)
  reviewerApply(ctx)
  brainApply(ctx) // registerBrain —— 占位大脑上线

  // 建会（走服务端同一条入册路径）：带「编码者」。
  const session = createSessionWithRoster(ctx, ['agent.coder'])

  // B1 分支一（命中）：@编码者 → 合法 JSON 委托，instruction = 人类原话。
  const HUMAN = '@agent.coder 实现登录页，先出方案'
  const ev1 = humanCommit(ctx, session.id, 'u_dri', HUMAN, ['agent.coder'])
  const r1 = await engine.onPlan({ sessionId: session.id, authorId: 'u_dri', event: ev1 })
  await new Promise((r) => setTimeout(r, 80)) // 委托认领是异步（事件总线）
  check('B1a 命中 → delegated', r1?.case === 'delegated', JSON.stringify(r1))
  check('B1b 委托目标 = 名册 title（编码者）', r1?.delegation?.target === '编码者', JSON.stringify(r1?.delegation))
  check('B1c instruction = 人类原话（逐字透传）', r1?.delegation?.instruction === HUMAN, JSON.stringify(r1?.delegation?.instruction))
  const evs1 = ctx.eventLog.listBySession(session.id)
  const announce = evs1.find((e) => e.authorId === 'a_coordinator' && e.text.includes('将委托[编码者]'))
  check('B1d 宣告带大脑附言且明示占位（非 NLP）',
    !!announce && announce.text.includes('大脑附言') && announce.text.includes('占位大脑（非 NLP，等待模型 key）'),
    announce?.text)

  // B2 回执链路闭环：coder 认领 → 工作区落盘（含提示词段）→ 收执 → await_human。
  const receipt = evs1.find((e) => e.authorId === 'agent.coder' && e.authorKind === 'agent')
  check('B2a coder 回执落时间线且含【提示词】（promptRef 绑定可见）',
    !!receipt && receipt.text.includes('【工作区】') && receipt.text.includes('【提示词】') && receipt.text.includes('编码者提示词（角色2）'),
    receipt?.text)
  check('B2b 收执后 await_human 暂停（收到反馈必须停）',
    engine.turn(session.id).state === 'static' && engine.turn(session.id).stopReason === 'await_human',
    JSON.stringify(engine.turn(session.id)))

  // B3 分支二（未命中）：无 @ → 纯文本回复，不委托，明示占位。
  const announcesBefore = ctx.eventLog.listBySession(session.id).filter((e) => e.text.includes('将委托[')).length
  const ev2 = humanCommit(ctx, session.id, 'u_dri', '大家先看看这份纪要')
  const r2 = await engine.onPlan({ sessionId: session.id, authorId: 'u_dri', event: ev2 })
  check('B3a 未命中 → replied（不委托）', r2?.case === 'replied' && r2.delegation === null, JSON.stringify(r2))
  check('B3b 回复明示占位大脑（非 NLP，等待模型 key）',
    typeof r2?.reply === 'string' && r2.reply.includes('占位大脑（非 NLP，等待模型 key）'), r2?.reply)
  check('B3c 未命中不新增委托宣告（账本计数不变）',
    ctx.eventLog.listBySession(session.id).filter((e) => e.text.includes('将委托[')).length === announcesBefore)
  check('B3d 未命中后暂停等人类（await_human）', engine.turn(session.id).stopReason === 'await_human')

  // B4 config 可关：enabled=false → 不注册大脑 → coordinator_unconfigured 安全默认。
  const db4 = memoryDb(true)
  const ctx4 = new Context()
  new SqliteSessionStore(ctx4, db4)
  new SqliteEventLog(ctx4, db4)
  new AgentRegistry(ctx4)
  const engine4 = new OrchestratorEngine(ctx4)
  brainApply(ctx4, { enabled: false })
  // 会话落在 ctx4 自己的库里（B 的 session.id 属于另一个 ：memory: 库，FK 会炸）。
  const s4 = ctx4.session.createSession({ title: '关断验证' })
  const ev4 = ctx4.eventLog.append({
    id: randomUUID(), sessionId: s4.id, authorId: 'u_dri', phaseId: null,
    authorKind: 'human', kind: 'message', text: '你好', mentions: [], toolCalls: [], replyMode: '',
  })
  await engine4.onPlan({ sessionId: s4.id, authorId: 'u_dri', event: ev4 })
  const t4 = engine4.turn(s4.id)
  check('B4 config.enabled=false → 回 coordinator_unconfigured（关 = 安全默认）',
    t4.state === 'static' && t4.stopReason === 'coordinator_unconfigured', JSON.stringify(t4))
  db4.close()

  rmSync(tmp, { recursive: true, force: true })
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part C —— 建会名册 + promptRef 绑定（服务端同一条入册路径）
// ══════════════════════════════════════════════════════════════════════════
async function partC(): Promise<void> {
  section('Part C：建会名册（默认 6 席）+ coding 多选 + promptRef 绑定')

  const db = memoryDb(true)
  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqlitePromptStore(ctx, db)
  new AgentRegistry(ctx)
  new CommandService(ctx)
  runtimeApply(ctx)
  coderApply(ctx)
  testerApply(ctx)
  reviewerApply(ctx)

  // C1 默认名册 6 席（补 P7 遗留 1）+ 附加「编码者」。
  const s1 = createSessionWithRoster(ctx, ['agent.coder'])
  const m1 = ctx.session.listMembers(s1.id, true)
  const byId = new Map(m1.map((m) => [m.principalId, m]))
  check('C1a 默认名册齐 6 席（DRI + 协调者 + 会议三机器人 + 编码者）', m1.length === 6, JSON.stringify(m1.map((m) => m.principalId)))
  check('C1b 协调者在册且不进授权语义（角色=协调者）', byId.get('a_coordinator')?.role === '协调者')
  check('C1c 会议三机器人在册（需求分析师/挑战者/会议记录官）',
    byId.get('a_analyst')?.role === '需求分析师' && byId.get('a_challenger')?.role === '挑战者' && byId.get('a_recorder')?.role === '会议记录官')
  check('C1d coding 多选入会：agent.coder 以本 id 入会（role=成员，duty=编码者）',
    byId.get('agent.coder')?.role === '成员' && byId.get('agent.coder')?.duty === '编码者', JSON.stringify(byId.get('agent.coder')))

  // C2 名册外 id 忽略不炸；未选中者不入会。
  const s2 = createSessionWithRoster(ctx, ['agent.nobody'])
  const m2 = ctx.session.listMembers(s2.id, true)
  check('C2a 名册外 id 忽略（默认名册仍齐 5 席）', m2.length === 5 && !m2.some((m) => m.principalId === 'agent.nobody'),
    JSON.stringify(m2.map((m) => m.principalId)))
  check('C2b 未选中的 coding agent 不入会（测试者/审查者缺席）',
    !m2.some((m) => m.principalId === 'agent.tester' || m.principalId === 'agent.reviewer'))

  // C3 promptRef 绑定闭环：三 stub 的引用都能在 prompt_templates 取到内容。
  const roster = ctx.agents.list('coding')
  const binding = roster.map((a) => {
    const ref = a.descriptor.promptRef
    try {
      return { id: a.descriptor.id, ref, title: ref ? ctx.prompts.get(ref).title : null }
    } catch {
      return { id: a.descriptor.id, ref, title: null }
    }
  })
  check('C3a 三 coding stub 的 promptRef 全部绑定到真实提示词',
    binding.every((b) => b.ref && b.title), JSON.stringify(binding))
  check('C3b ref ↔ 角色逐一对位（coding/testing/review）',
    binding.find((b) => b.id === 'agent.coder')?.ref === 'prompt.coding' &&
    binding.find((b) => b.id === 'agent.tester')?.ref === 'prompt.testing' &&
    binding.find((b) => b.id === 'agent.reviewer')?.ref === 'prompt.review',
    JSON.stringify(binding))
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part D —— 双 stub 入驻纯新增（⑪ 回归）+ 委托定向性 + /tell 共享路径
// ══════════════════════════════════════════════════════════════════════════
async function partD(): Promise<void> {
  section('Part D：双 stub 入驻回归（名册形状 / 委托定向性 / /tell 共享干活路径）')

  const tmp = mkdtempSync(join(tmpdir(), 'p8-stubs-'))
  const db = memoryDb(true)
  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqliteEventLog(ctx, db)
  new SqlitePromptStore(ctx, db)
  new AgentRegistry(ctx)
  new CommandService(ctx)
  new LocalWorkdirService(ctx, tmp)
  const engine = new OrchestratorEngine(ctx)
  runtimeApply(ctx)
  coderApply(ctx)
  testerApply(ctx)
  reviewerApply(ctx)
  brainApply(ctx)

  // D1 名册形状（报到即 idle；id 稳定排序；promptRef/capabilities 各就各位）。
  const roster = ctx.agents.list('coding').map((a) => a.descriptor)
  check('D1a 三个 coding stub 全部入驻（id 稳定排序）',
    roster.map((d) => d.id).join(',') === 'agent.coder,agent.reviewer,agent.tester',
    roster.map((d) => d.id).join(','))
  check('D1b title/capabilities 各就各位',
    roster.find((d) => d.id === 'agent.tester')?.title === '测试者' &&
    roster.find((d) => d.id === 'agent.tester')?.capabilities.includes('testing') &&
    roster.find((d) => d.id === 'agent.reviewer')?.title === '代码审查者' &&
    roster.find((d) => d.id === 'agent.reviewer')?.capabilities.includes('review'))
  check('D1c 报到即 idle', roster.every((d) => ctx.agents.get(d.id).status === 'idle'))

  // D2 委托定向性：@测试者 → 只有 tester 认领回执，coder/reviewer 静默。
  const session = createSessionWithRoster(ctx, ['agent.coder', 'agent.tester', 'agent.reviewer'])
  const ev = humanCommit(ctx, session.id, 'u_dri', '@agent.tester 给登录页补冒烟测试', ['agent.tester'])
  const r = await engine.onPlan({ sessionId: session.id, authorId: 'u_dri', event: ev })
  await new Promise((r2) => setTimeout(r2, 80))
  check('D2a 委托「测试者」成立', r?.case === 'delegated' && r.delegation?.target === '测试者', JSON.stringify(r))
  const evs = ctx.eventLog.listBySession(session.id)
  const receipts = evs.filter((e) => e.authorKind === 'agent' && ['agent.coder', 'agent.tester', 'agent.reviewer'].includes(e.authorId ?? ''))
  check('D2b 只有测试者回执（定向认领，无越俎代庖）',
    receipts.length === 1 && receipts[0]!.authorId === 'agent.tester' &&
    receipts[0]!.text.includes('已领任务：') && receipts[0]!.text.includes('给登录页补冒烟测试'),
    JSON.stringify(receipts.map((e) => e.authorId)))
  check('D2c 测试者回执含【提示词】测试者提示词（角色3）',
    receipts[0]!.text.includes('测试者提示词（角色3）'), receipts[0]!.text)
  check('D2d 收执后 await_human（铁律不变式在全名册下照旧）',
    engine.turn(session.id).stopReason === 'await_human')

  // D3 /tell 直派走共享干活路径（升格后的机制口，回执形状一致）。
  const dispatch = (text: string) => {
    const inv = parse(text)
    if (!inv) throw new Error(`parse 失败：${text}`)
    return ctx.commands.dispatch({ sessionId: session.id, authorId: 'u_dri', arg: '', args: [], raw: text } satisfies CommandCtx, inv)
  }
  const told = await dispatch('/tell @代码审查者 复核登录页方案')
  check('D3a /tell 直派审查者回执（共享干活路径）',
    told.text.includes('[@代码审查者] 已领任务：复核登录页方案'), told.text)
  check('D3b 回执含【工作区】与【产物清单】', told.text.includes('【工作区】') && told.text.includes('【产物清单】'))
  check('D3c 干活后状态归位 idle', ctx.agents.get('agent.reviewer').status === 'idle')

  rmSync(tmp, { recursive: true, force: true })
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(`verify-p8：P8 机制层验收（提示词 + 占位大脑 + 建会名册 + 双 stub 入驻；断言 ⑬）`)
  await partA()
  await partB()
  await partC()
  await partD()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-p8 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  // 留痕（断言 ⑨）：直接写 action_log（verify-workdir 同款内联直写）。
  const dbPath = process.cwd() + '/data/database.db'
  if (existsSync(dbPath)) {
    const log = new DatabaseSync(dbPath)
    const has = log.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='action_log'`).get()
    if (has.n) {
      log.prepare(`INSERT INTO action_log(action, detail, ok, created_at) VALUES (?, ?, 1, ?)`)
        .run('verify-p8', '{"ok":true}', new Date().toISOString())
      console.log('· 留痕：verify-p8 → action_log')
    }
    log.close()
  }
  console.log('✓ verify-p8 全过（断言留痕：action_log: verify-p8）')
}

await main()

// ── 红测自检记录（铁律 2：断言必须能红；2026-09-30 实测）──────────────────
//   改坏方式：BRAIN_SABOTAGE=1 npm run verify:p8（brain-stub 内置探针：
//   未命中分支也吐委托 JSON —— 决策形状改坏）。
//   实测结果：B3a/B3c/B3d 三红（未命中分支变成 delegated、新增委托宣告、
//   停止原因变了），退出码 1；还原（不设 env）复绿 42 过 / 0 红。
//   附带修正（红测暴露的断言形状问题，非代码 bug）：D2b 原断言回执含
//   「已领任务：给登录页补冒烟测试」—— 但 instruction 是人类原话逐字透传
//   （含 @token 前缀），改为「已领任务：」+「给登录页补冒烟测试」两段包含。
//   覆盖说明：⑪ 的白名单静态扫描由 gate 链 verify:agents Part C 承担
//   （verify-p8.ts 已列其白名单），本脚本不重复扫描。
