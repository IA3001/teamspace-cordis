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
//     文案处处带【占位】标记（2026-09-30 拍板瘦身：原「占位大脑（非 NLP，等待
//     模型 key）」长前缀缩为【占位】）；config.enabled=false
//     → 回 coordinator_unconfigured 安全默认。
//     **红测**：BRAIN_SABOTAGE=1（brain-stub 内置探针）—— 未命中也吐委托
//     JSON，分支二断言必红；还原（不设 env）复绿。铁律要求断言「故意改坏
//     会红」，本探针就是那个改坏形态（自检记录见文末）。
//   Part C（进程内，建会名册）：createSessionWithRoster（服务端建会与 RPC
//     同一条代码路径）—— 默认名册 6 席（DRI + 协调者 + 会议三机器人，补
//     P7 遗留 1）+ coding 多选入会（role=成员、duty=名册 title）+ 名册外
//     id 忽略 + promptRef 绑定闭环（默认 Agent 模板的 promptRef 均能在
//     prompt_templates 里取到内容）。
//   Part D（进程内，catalog Agent ⑪ 回归）：共享目录实例同场 —— 目录形状
//     （id 排序 / title / promptRef / capabilities / 报到即 idle）+ 委托定向性
//     （委托「测试者」只有目标 Agent 回执）+ /tell 直派走共享干活路径。
//   Part E（P8 下半场扩容，2026-09-30，进程内 + 进程内 mock OpenAI 兼容服务）：
//     门禁不依赖真 key —— main() 先清 LLM 三件套（A–D 恒为占位模式），本
//     Part 自管 env（注入 mock 三件套，finally 还原）：
//     E1 无 key → 大脑选择确定性（stub 上线、brain-llm 让位、两 apply 不炸）；
//     E2 有 key（mock）→ brain-llm 上线，合法 JSON 过兜底 0 层逐字直通；
//     E3 LLM 纯文本 → replied（1 层）、mock 500 → coordinator_error（不猜不重试）；
//     E4 perform 真模型模式（提示词取用 + artifact 落盘 + 回执【真模型】+model
//        + AgentExecutionReceipt.mode='llm'）；并创建非特化 ID 的自定义 catalog Agent，
//        验收邀请、通用 dispatcher、配置工具调用和回执；E5 无 key 占位模式。
//     **红测**：LLM_SABOTAGE=1（agent-runtime 内置探针）—— 真模型模式谎报
//     【占位】，E4a 必红；还原（不设 env）复绿（自检记录见文末）。
//
// 用法：npm run verify:p8    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-p8（断言 ⑨；内联直写 ——
// tsx 下 execFileSync 会踩 Windows shim，承 verify-workdir 实测教训）。
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentExecutionFailureError, AgentRunCancelledError } from 'space-agent-runtime'
import { PromptError } from 'space-prompt'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqlitePromptStore } from '../packages/impl/space-store-sqlite/src/prompt.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'
import { SqliteAgentCatalog } from '../packages/impl/space-store-sqlite/src/agent-catalog.ts'
import { SqliteUserStore } from '../packages/impl/space-store-sqlite/src/users.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { AGENT_PROGRESS_HEARTBEAT_MS, apply as runtimeApply } from '../packages/impl/space-agent-runtime/src/index.ts'
import { apply as agentDispatcherApply } from '../plugins/agent-runtime-dispatcher/index.ts'
import { apply as brainApply } from '../plugins/brain-stub/index.ts'
import { apply as brainLlmApply } from '../plugins/brain-llm/index.ts'
import { OpenAiChatLlm } from '../packages/impl/space-llm-openai/src/index.ts'
import { LLM_API_KEY_ENV, LLM_BASE_URL_ENV, LLM_MODEL_ENV } from 'space-llm'
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

/** Load the shipped Agent definitions as data and register the shared runtime dispatcher. */
function applyCatalogAgents(ctx: Context, db: DatabaseSync): AgentRegistry {
  const catalog = new SqliteAgentCatalog(ctx, db)
  Object.assign(ctx, { agentCatalog: catalog })
  const registry = new AgentRegistry(ctx)
  registry.bindCatalog(catalog)
  return registry
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

  // A6 seed 0002：四条可用默认提示词 + 幂等。
  const seedDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/seed/', import.meta.url))
  db.exec(readFileSync(join(seedDir, '0002_svc_prompt.sql'), 'utf8'))
  const seeded = prompts.list()
  check('A6a seed 落 4 条占位（角色 1~4）',
    ['prompt.minutes', 'prompt.coding', 'prompt.testing', 'prompt.review'].every((r) => seeded.some((x) => x.ref === r)),
    JSON.stringify(seeded.map((x) => x.ref)))
  const SEEDED_REFS = ['prompt.minutes', 'prompt.coding', 'prompt.testing', 'prompt.review']
  check('A6b 默认提示词有实际职责说明',
    seeded.filter((x) => SEEDED_REFS.includes(x.ref)).every((x) => x.body.length > 30 && x.body.includes('职责')))
  const before = seeded.length
  db.exec(readFileSync(join(seedDir, '0002_svc_prompt.sql'), 'utf8'))
  check('A6c seed 重播幂等（INSERT OR IGNORE）', prompts.list().length === before)
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— 占位大脑两分支决策形状（真引擎 + 真 brain-stub 插件）
// ══════════════════════════════════════════════════════════════════════════
function humanCommit(ctx: Context, sessionId: string, authorId: string, text: string, mentions: string[] = [], notify = true) {
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
  if (notify) ctx.emit('staging/plan', { sessionId, authorId, event })
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
  applyCatalogAgents(ctx, db)
  new CommandService(ctx)
  new OpenAiChatLlm(ctx) // ctx.llm（main 已清 key → 占位模式；拓扑与运行时一致）
  new LocalWorkdirService(ctx, tmp)
  const engine = new OrchestratorEngine(ctx)
  // Seeded Team definitions enter through the same generic registry and dispatcher as custom Agents.
  runtimeApply(ctx)
  agentDispatcherApply(ctx)
  brainApply(ctx) // registerBrain —— 占位大脑上线

  // 建会（走服务端同一条入册路径）：带「编码者」。
  const session = createSessionWithRoster(ctx, ['agent.coder'])

  // A catalog definition alone does not authorize a target; the Agent must be invited.
  const uninvitedSession = createSessionWithRoster(ctx)
  const uninvitedEvent = humanCommit(ctx, uninvitedSession.id, 'u_dri', '@agent.tester 给登录页补冒烟测试', ['agent.tester'], false)
  const uninvitedResult = await engine.onPlan({ sessionId: uninvitedSession.id, authorId: 'u_dri', event: uninvitedEvent })
  check('B1x 未入会的 catalog Agent 不在协调器可用目标中且不会启动运行',
    uninvitedResult?.case === 'replied' && uninvitedResult.delegation === null && ctx.agents.get('agent.tester').status === 'idle',
    JSON.stringify({ result: uninvitedResult, status: ctx.agents.get('agent.tester').status }))

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
    !!announce && announce.text.includes('大脑附言') && announce.text.includes('【占位】') && announce.text.includes('非 NLP'),
    announce?.text)

  // B2 回执链路闭环：coder 认领 → 工作区落盘（含提示词段）→ 收执 → await_human。
  const receipt = evs1.find((e) => e.authorId === 'agent.coder' && e.authorKind === 'agent')
  check('B2a coder 回执落时间线且含【提示词】（promptRef 绑定可见）',
    !!receipt && receipt.text.includes('【工作区】') && receipt.text.includes('【提示词】') && receipt.text.includes('编码者提示词（角色2）'),
    receipt?.text)
  check('B2b 收执后按自治策略继续（不强制 await_human）',
    engine.turn(session.id).stopReason !== 'await_human',
    JSON.stringify(engine.turn(session.id)))

  // B3 分支二（未命中）：无 @ → 纯文本回复，不委托，明示占位。
  const announcesBefore = ctx.eventLog.listBySession(session.id).filter((e) => e.text.includes('将委托[')).length
  const ev2 = humanCommit(ctx, session.id, 'u_dri', '大家先看看这份纪要')
  const r2 = await engine.onPlan({ sessionId: session.id, authorId: 'u_dri', event: ev2 })
  check('B3a 未命中 → replied（不委托）', r2?.case === 'replied' && r2.delegation === null, JSON.stringify(r2))
  check('B3b 回复明示【占位】标记（2026-09-30 拍板瘦身）',
    typeof r2?.reply === 'string' && r2.reply.includes('【占位】'), r2?.reply)
  check('B3c 未命中不新增委托宣告（账本计数不变）',
    ctx.eventLog.listBySession(session.id).filter((e) => e.text.includes('将委托[')).length === announcesBefore)
  check('B3d 未命中回复后按自治策略结束或继续', engine.turn(session.id).stopReason !== 'await_human')

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
  section('Part C：建会名册（默认 6 席）+ catalog Agent 邀请 + promptRef 绑定')

  const db = memoryDb(true)
  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqlitePromptStore(ctx, db)
  applyCatalogAgents(ctx, db)
  new CommandService(ctx)
  runtimeApply(ctx)

  // C1 默认名册 5 席 + 显式邀请一个共享 catalog Agent。
  const s1 = createSessionWithRoster(ctx, ['agent.coder'])
  const m1 = ctx.session.listMembers(s1.id, true)
  const byId = new Map(m1.map((m) => [m.principalId, m]))
  check('C1a 默认名册 5 席并包含受邀 catalog Agent', m1.length === 6 && byId.get('agent.coder')?.role === '成员', JSON.stringify(m1.map((m) => m.principalId)))
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
  check('C2b 未邀请的共享 Agent 不入会（测试者/审查者缺席）',
    !m2.some((m) => m.principalId === 'agent.tester' || m.principalId === 'agent.reviewer'))

  // C3 promptRef 绑定闭环：三 stub 的引用都能在 prompt_templates 取到内容。
  const roster = ctx.agents.list().filter((agent) => ['agent.coder', 'agent.tester', 'agent.reviewer'].includes(agent.descriptor.id))
  const binding = roster.map((a) => {
    const ref = a.descriptor.promptRef
    try {
      return { id: a.descriptor.id, ref, title: ref ? ctx.prompts.get(ref).title : null }
    } catch {
      return { id: a.descriptor.id, ref, title: null }
    }
  })
  check('C3a 三个共享 catalog Agent 的 promptRef 全部绑定到真实提示词',
    binding.every((b) => b.ref && b.title), JSON.stringify(binding))
  check('C3b ref ↔ 角色逐一对位（coding/testing/review）',
    binding.find((b) => b.id === 'agent.coder')?.ref === 'prompt.coding' &&
    binding.find((b) => b.id === 'agent.tester')?.ref === 'prompt.testing' &&
    binding.find((b) => b.id === 'agent.reviewer')?.ref === 'prompt.review',
    JSON.stringify(binding))
  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part D —— catalog Agent 入驻（⑪ 回归）+ 委托定向性 + /tell 共享路径
// ══════════════════════════════════════════════════════════════════════════
async function partD(): Promise<void> {
  section('Part D：catalog Agent 回归（目录形状 / 委托定向性 / /tell 共享干活路径）')

  const tmp = mkdtempSync(join(tmpdir(), 'p8-stubs-'))
  const db = memoryDb(true)
  const ctx = new Context()
  new SqliteSessionStore(ctx, db)
  new SqliteEventLog(ctx, db)
  new SqlitePromptStore(ctx, db)
  applyCatalogAgents(ctx, db)
  new CommandService(ctx)
  new OpenAiChatLlm(ctx) // ctx.llm（main 已清 key → 占位模式）
  new LocalWorkdirService(ctx, tmp)
  const engine = new OrchestratorEngine(ctx)
  runtimeApply(ctx)
  agentDispatcherApply(ctx)
  brainApply(ctx)

  // D1 名册形状（报到即 idle；id 稳定排序；promptRef/capabilities 各就各位）。
  const roster = ctx.agents.list()
    .filter((agent) => ['agent.coder', 'agent.tester', 'agent.reviewer'].includes(agent.descriptor.id))
    .map((agent) => agent.descriptor)
  check('D1a 三个 coding stub 全部入驻（id 稳定排序）',
    roster.map((d) => d.id).join(',') === 'agent.coder,agent.reviewer,agent.tester',
    roster.map((d) => d.id).join(','))
  check('D1b title/tool 配置各就各位',
    roster.find((d) => d.id === 'agent.tester')?.title === '测试者' &&
    roster.find((d) => d.id === 'agent.tester')?.toolIds?.includes('tool.code.execute') &&
    roster.find((d) => d.id === 'agent.reviewer')?.title === '代码审查者' &&
    roster.find((d) => d.id === 'agent.reviewer')?.toolIds?.includes('tool.workspace.read'))
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
  check('D2d 收执后不强制 await_human（全名册自治策略一致）',
    engine.turn(session.id).stopReason !== 'await_human')

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
// Part E —— LLM 接入（本地 mock OpenAI 兼容服务；门禁不依赖真 key）
// ══════════════════════════════════════════════════════════════════════════
async function partE(): Promise<void> {
  section('Part E：LLM 接入（进程内 mock OpenAI 兼容服务）' + (process.env.LLM_SABOTAGE === '1' ? '【SABOTAGE 模式】' : ''))

  // mock /chat/completions：node:http 进程内起（端口 0 = 随机分配，无子进程
  // —— 承 verify-workdir 的 Windows shim 教训）；behavior 可切换。
  const mock: { mode: 'ok-json' | 'ok-artifact' | 'ok-tool' | 'ok-text' | 'long-stream' | 'stream-drop' | 'http500' | 'hold'; requests: number } = {
    mode: 'ok-json', requests: 0,
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c })
    req.on('end', () => {
      const requestBody = JSON.parse(body) as { messages?: Array<{ content?: string }> }
      mock.requests++
      if (mock.mode === 'hold') {
        return
      }
      if (mock.mode === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock boom' } }))
        return
      }
      if (mock.mode === 'stream-drop') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已生成但未提交' } }] })}\n\n`)
        setTimeout(() => res.destroy(), 25)
        return
      }
      if (mock.mode === 'long-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (let i = 0; i < 3; i++) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '长'.repeat(6000) } }] })}\n\n`)
        }
        res.end('data: [DONE]\n\n')
        return
      }
      const afterTool = requestBody.messages?.some((message) => message.content?.includes('工具结果 web.search')) ?? false
      const content = mock.mode === 'ok-json'
        ? JSON.stringify({ reply: 'MOCK-协调者回复', reason: 'mock 决策', delegate: { target: '需求分析师', instruction: 'MOCK-分析边界条件' } })
        : mock.mode === 'ok-artifact'
          ? 'MOCK-产物正文：登录页方案（分三步走）……'
          : mock.mode === 'ok-tool'
            ? afterTool ? 'MOCK-工具调用后的最终答复' : JSON.stringify({ toolCalls: [{ toolId: 'web.search', args: { query: 'safe test query' } }] })
          : '我先想想，暂不派单。'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mockPort = (server.address() as { port: number }).port

  // env 自管（确定性）：保存 → 注入/清除 → finally 还原（不留探针残留）。
  const saved = [LLM_API_KEY_ENV, LLM_BASE_URL_ENV, LLM_MODEL_ENV].map((k) => [k, process.env[k]] as const)
  const setEnv = () => {
    process.env[LLM_API_KEY_ENV] = 'mock-key'
    process.env[LLM_BASE_URL_ENV] = `http://127.0.0.1:${mockPort}/v1`
    process.env[LLM_MODEL_ENV] = 'mock-model'
  }
  const clearEnv = () => {
    for (const [k] of saved) delete process.env[k]
  }
  try {
    clearEnv()

    // Admin API settings are the preferred runtime source. With env empty, both
    // brain providers must still agree on one configured LLM and register only
    // brain-llm (the former env-only stub check caused duplicate_brain here).
    {
      const configuredValues: Record<string, string> = {
        'llm.apiKey': 'settings-mock-key',
        'llm.baseURL': 'https://settings.mock/v1',
        'llm.model': 'settings-mock-model',
      }
      const settings = {
        get<T>(key: string, fallback: T): T { return (configuredValues[key] as T | undefined) ?? fallback },
        set() {},
      }
      const ctx = new Context()
      const brains: unknown[] = []
      Object.assign(ctx, { settings, orchestrator: { registerBrain(brain: unknown) { brains.push(brain) } } })
      new OpenAiChatLlm(ctx, {}, settings as never)
      brainApply(ctx)
      brainLlmApply(ctx)
      check('E0 后台 settings 配置（无 LLM_* env）只注册真模型大脑', brains.length === 1, `registered=${brains.length}`)
    }

    // E1 无 key → 大脑选择确定性：两脑都 apply（组合根顺序 stub 先），只有
    // stub 注册（让位日志在 5172 可见）；未命中 → 占位回复。
    {
      const tmp = mkdtempSync(join(tmpdir(), 'p8-llm-a-'))
      const db = memoryDb(true)
      const ctx = new Context()
      new SqliteSessionStore(ctx, db)
      new SqliteEventLog(ctx, db)
      new SqlitePromptStore(ctx, db)
      new SqliteSettingsStore(ctx, db)
      applyCatalogAgents(ctx, db)
      new CommandService(ctx)
      new OpenAiChatLlm(ctx)
      new LocalWorkdirService(ctx, tmp)
      const engine = new OrchestratorEngine(ctx)
      runtimeApply(ctx)
      agentDispatcherApply(ctx)
      ctx.session.createSession({ id: 's_progress', title: '进度事件验收' })
      Object.assign(ctx, { tools: {
        list: () => [{ id: 'web.search', title: 'Web search', description: 'mock search', capabilities: [] }],
        invoke: async () => ({ toolId: 'web.search', ok: true, output: 'MOCK-搜索结果', costMs: 1 }),
      } })
      brainApply(ctx)    // 组合根顺序：stub 行在前 —— key 缺 → 上线
      brainLlmApply(ctx) // key 缺 → 让位（不注册、不炸）
      const s1 = createSessionWithRoster(ctx)
      const ev1 = humanCommit(ctx, s1.id, 'u_dri', '大家先看看这份纪要')
      const r1 = await engine.onPlan({ sessionId: s1.id, authorId: 'u_dri', event: ev1 })
      check('E1 无 key → brain-stub 上线（占位回复；brain-llm 让位不炸不重复）',
        r1?.case === 'replied' && r1.reply.includes('【占位】'), JSON.stringify(r1))
      rmSync(tmp, { recursive: true, force: true })
      db.close()
    }

    setEnv()

    // E2/E3 有 key（mock base）→ brain-llm 上线；原始输出过三级兜底零改动。
    {
      const db = memoryDb(true)
      const ctx = new Context()
      new SqliteSessionStore(ctx, db)
      new SqliteEventLog(ctx, db)
      new SqlitePromptStore(ctx, db)
      new SqliteSettingsStore(ctx, db)
      applyCatalogAgents(ctx, db)
      new CommandService(ctx)
      new OpenAiChatLlm(ctx)
      const engine = new OrchestratorEngine(ctx)
      brainApply(ctx)    // key 在 → 让位（不注册）
      brainLlmApply(ctx) // configured → 注册
      const s = createSessionWithRoster(ctx)

      // E2 兜底 0 层：合法 JSON → delegated，mock 决策逐字透传（原始输出未被动过）。
      const ev = humanCommit(ctx, s.id, 'u_dri', '@需求分析师 分析边界条件', ['a_analyst'])
      const r = await engine.onPlan({ sessionId: s.id, authorId: 'u_dri', event: ev })
      check('E2a brain-llm 合法 JSON → delegated（兜底 0 层直通）',
        r?.case === 'delegated' && r.delegation?.target === '需求分析师', JSON.stringify(r))
      check('E2b mock 决策逐字透传（instruction/reply 未被改写）',
        r?.delegation?.instruction === 'MOCK-分析边界条件' && r.reply === 'MOCK-协调者回复', JSON.stringify(r))

      // E3 兜底 1 层：LLM 纯文本 → replied（三级兜底零改动的直观测点）。
      mock.mode = 'ok-text'
      const ev2 = humanCommit(ctx, s.id, 'u_dri', '随便聊聊')
      const r2 = await engine.onPlan({ sessionId: s.id, authorId: 'u_dri', event: ev2 })
      check('E3 LLM 纯文本 → replied（三级兜底 1 层路径不变）',
        r2?.case === 'replied' && r2.delegation === null && r2.reply.includes('我先想想'), JSON.stringify(r2))

      // E3b 调用失败 → coordinator_error 暂停（既有路径零改动；单次不重试不猜）。
      mock.mode = 'http500'
      const ev3 = humanCommit(ctx, s.id, 'u_dri', '再来一轮')
      await engine.onPlan({ sessionId: s.id, authorId: 'u_dri', event: ev3 })
      const t3 = engine.turn(s.id)
      check('E3b LLM 调用失败 → coordinator_error 暂停（不猜不重试）',
        t3.state === 'static' && t3.stopReason === 'coordinator_error', JSON.stringify(t3))
      db.close()
    }

    // E4 perform 真模型模式：提示词取用 + artifact 落盘 + 回执诚实标注。
    {
      const tmp = mkdtempSync(join(tmpdir(), 'p8-llm-b-'))
      const db = memoryDb(true)
      const ctx = new Context()
      const progressEvents: Array<{ sessionId: string; agentId: string; sourceEventId: string | null; phase: string; toolId?: string; toolTitle?: string; ok?: boolean; delta?: string; step?: { inputSummary?: string; resultSummary?: string } }> = []
      ctx.on('space/agent-progress', (update) => progressEvents.push(update))
      new SqliteEventLog(ctx, db)
      const sessions = new SqliteSessionStore(ctx, db)
      new SqliteUserStore(ctx, db)
      sessions.createSession({ id: 's_progress', title: '进度事件验收' })
      new SqlitePromptStore(ctx, db)
      new SqliteSettingsStore(ctx, db)
      const registry = applyCatalogAgents(ctx, db)
      new CommandService(ctx)
      new LocalWorkdirService(ctx, tmp)
      new OpenAiChatLlm(ctx)
      Object.assign(ctx, { context: { assemble: async () => ({ system: 'test context', memories: [], retrieval: [], history: [] }) } })
      runtimeApply(ctx)
      agentDispatcherApply(ctx)
      Object.assign(ctx, { tools: {
        list: () => [{ id: 'web.search', title: '网络搜索', description: 'mock search', capabilities: [] }],
        invoke: async () => ({ toolId: 'web.search', ok: true, output: 'MOCK-搜索结果', costMs: 1 }),
      } })
      ctx.agents.get('agent.coder').descriptor.toolIds = ['web.search']
      mock.mode = 'ok-artifact'
      const r = await ctx.agentRuntime.perform('agent.coder', 'MOCK-实现登录页', {
        sessionId: 's_progress', sourceEventId: 'evt_progress',
      })
      check('E4a 回执诚实标注【真模型】+ model=mock-model、mode=llm（LLM_SABOTAGE=1 时此处红）',
        r.mode === 'llm' && r.receipt.includes('【真模型】') && r.receipt.includes('model=mock-model'),
        r.receipt)
      check('E4b 产物按任务目录归档：task.md + artifacts/answer.md',
        r.files.length === 2 && r.files[0]!.startsWith('tasks/') && r.files[0]!.endsWith('/task.md') &&
          r.files[1]!.startsWith('tasks/') && r.files[1]!.endsWith('/artifacts/answer.md') &&
          r.files[0]!.split('/')[1] === r.files[1]!.split('/')[1],
        JSON.stringify(r.files))
      const artifact = readFileSync(join(r.root, r.files[1]!), 'utf8')
      check('E4c artifact 含 LLM 输出正文（MOCK-产物正文）', artifact.includes('MOCK-产物正文'), artifact.slice(0, 120))
      check('E4d 任务文件含 promptRef 提示词正文（取自 ctx.prompts）',
        readFileSync(join(r.root, r.files[0]!), 'utf8').includes('你是团队的编码者'))
      check('E4d2 人类可见的运行进度只含阶段元数据，不落会话事件或暴露任务正文',
        progressEvents.map((event) => event.phase).includes('started') &&
          progressEvents.map((event) => event.phase).includes('completed') &&
          progressEvents.every((event) => event.sessionId === 's_progress' && event.agentId === 'agent.coder' &&
            event.sourceEventId === 'evt_progress' && !('task' in event) && !('content' in event)) &&
          ctx.eventLog.listBySession('s_progress').length === 0,
        JSON.stringify(progressEvents.map(({ phase, toolId }) => ({ phase, toolId }))))
      check('E4d2b 最终回复 token 实时发送但不写入事件时间线',
        progressEvents.some((event) => event.phase === 'text-delta' && event.delta?.includes('MOCK-产物正文')) &&
          !progressEvents.some((event) => event.delta?.includes('MOCK-实现登录页')) &&
          ctx.eventLog.listBySession('s_progress').length === 0)
      mock.mode = 'ok-tool'
      const toolRun = await ctx.agentRuntime.perform('agent.coder', 'MOCK-运行搜索工具', {
        sessionId: 's_progress', sourceEventId: 'evt_tool_progress',
      })
      const toolProgress = progressEvents.filter((event) => event.sourceEventId === 'evt_tool_progress')
      const hasToolInput = toolProgress.some((event) => event.phase === 'tool-start' && event.step?.inputSummary?.includes('safe test query'))
      const hasToolResult = toolProgress.some((event) => event.phase === 'tool-finish' && event.step?.resultSummary?.includes('MOCK-搜索结果'))
      check('E4d3 人类进度流显示脱敏的工具输入/结果摘要',
        toolRun.toolResults?.length === 1 &&
          hasToolInput && hasToolResult &&
          toolRun.worklog?.some((step) => step.kind === 'tool' && step.inputSummary && step.resultSummary) &&
          !toolProgress.some((event) => event.phase === 'text-delta' && event.delta?.includes('safe test query')),
        JSON.stringify({ resultCount: toolRun.toolResults?.length, hasToolInput, hasToolResult,
          worklog: toolRun.worklog?.filter((step) => step.kind === 'tool') }))

      // Reproduce Teamspace's data-first creation path with a fresh ID and no
      // Agent-specific plugin: catalog definition → identity → registry → invite
      // → generic dispatch → configured tool → timeline receipt.
      const customId = 'research_helper_42'
      const customDefinition = ctx.agentCatalog.create({
        title: '自定义研究助手', description: '使用团队搜索工具完成研究任务并提供依据。',
        promptRef: 'prompt.custom.research', modelRef: 'mock-model', toolIds: ['web.search'],
        contextSources: ['session', 'agent-memory', 'team-kb'], memoryPolicy: 'agent', speechPolicy: 'passive',
      }, customId)
      ctx.prompts.upsert(customDefinition.promptRef, customDefinition.title, '你是团队自定义研究助手，使用工具检索并引用证据。')
      ctx.users.registerAgent(customDefinition.id, customDefinition.title)
      registry.refreshCatalog()
      const customSession = createSessionWithRoster(ctx, [customDefinition.id])
      const customTask = humanCommit(ctx, customSession.id, 'u_dri', '@research_helper_42 调查当前供应商状态', [customId], false)
      const customEngine = new OrchestratorEngine(ctx)
      mock.mode = 'ok-tool'
      customEngine.beginExternalDelegate(customSession.id, customTask.id, customDefinition.title, customTask.text)
      for (let i = 0; i < 200 && !ctx.eventLog.listBySession(customSession.id).some((event) => event.authorId === customId); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const customEvents = ctx.eventLog.listBySession(customSession.id)
      const customReceipt = customEvents.find((event) => event.authorId === customId && event.authorKind === 'agent')
      check('E4d4 新建的自定义 Agent 使用非特化 ID，受邀后经通用 dispatcher 调用配置工具并回执',
        customReceipt?.text.includes('MOCK-工具调用后的最终答复') === true &&
          customReceipt.text.includes('自定义研究助手') &&
          customEvents.some((event) => event.kind === 'system' && event.text.includes(`${customId} 调用工具 web.search：成功`)) &&
          ctx.agents.get(customId).status === 'idle',
        JSON.stringify({ events: customEvents.map((event) => [event.authorId, event.kind, event.text]),
          progress: progressEvents.filter((event) => event.agentId === customId).map(({ phase, toolId }) => [phase, toolId]),
          status: ctx.agents.get(customId).status }))
      mock.mode = 'hold'
      const requestsBeforeCancel = mock.requests
      const artifactCountBeforeCancel = readdirSync(r.root).filter((name) => name.startsWith('artifact-')).length
      const nativeSetInterval = globalThis.setInterval
      let triggerHeartbeat: (() => void) | undefined
      const controlledSetInterval: typeof setInterval = (handler, timeout, ...args) => {
        if (timeout === AGENT_PROGRESS_HEARTBEAT_MS) {
          const hold = setTimeout(() => {}, 60_000)
          triggerHeartbeat = () => handler(...args)
          return hold as unknown as ReturnType<typeof setInterval>
        }
        return nativeSetInterval(handler, timeout, ...args)
      }
      globalThis.setInterval = controlledSetInterval
      let cancellationError: unknown
      try {
        const staleRun = ctx.agentRuntime.perform('agent.coder', 'MOCK-撤回时取消运行', {
          sessionId: 's_progress', sourceEventId: 'evt_cancel_run',
        })
        for (let i = 0; i < 100 && mock.requests === requestsBeforeCancel; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        const reconnectSnapshot = ctx.agentRuntime.listActiveProgress().find((run) => run.sourceEventId === 'evt_cancel_run')
        check('E4e0 在途运行可向重连界面提供当前阶段快照',
          reconnectSnapshot?.phase === 'waiting-model' && reconnectSnapshot.steps.some((step) => step.label === '准备专属工作区') &&
            reconnectSnapshot.steps.some((step) => step.label === '整理会话、记忆与知识库上下文') &&
            reconnectSnapshot.steps.some((step) => step.label === '正在请求模型，等待首个响应'),
          JSON.stringify(reconnectSnapshot && { phase: reconnectSnapshot.phase, steps: reconnectSnapshot.steps }))
        const priorHeartbeatAt = reconnectSnapshot?.at
        const priorStepCount = reconnectSnapshot?.steps.length
        triggerHeartbeat?.()
        const heartbeatSnapshot = ctx.agentRuntime.listActiveProgress().find((run) => run.sourceEventId === 'evt_cancel_run')
        const heartbeatEvent = progressEvents.filter((event) => event.sourceEventId === 'evt_cancel_run').at(-1)
        check('E4e0b 慢模型等待期间心跳刷新最近活动但保留阶段起始时间',
          Boolean(triggerHeartbeat) && heartbeatSnapshot?.phase === 'waiting-model' && heartbeatSnapshot.at !== priorHeartbeatAt &&
            heartbeatSnapshot.steps.length === priorStepCount && heartbeatSnapshot.steps.at(-1)?.label === '正在请求模型，等待首个响应' &&
            heartbeatEvent?.phase === 'waiting-model' && heartbeatEvent.at === heartbeatSnapshot.at,
          JSON.stringify(heartbeatSnapshot && { phase: heartbeatSnapshot.phase, at: heartbeatSnapshot.at, steps: heartbeatSnapshot.steps }))
        const cancelledCount = await ctx.agentRuntime.cancelBySource('evt_cancel_run')
        try { await staleRun } catch (error) { cancellationError = error }
        await new Promise((resolve) => setImmediate(resolve))
        check('E4e 撤回来源会 AbortSignal 取消在途模型请求并等待运行收束',
          cancelledCount === 1 && cancellationError instanceof AgentRunCancelledError &&
            ctx.agents.get('agent.coder').status === 'idle' && !ctx.agentRuntime.listActiveProgress().some((run) => run.sourceEventId === 'evt_cancel_run'),
          `count=${cancelledCount}, error=${(cancellationError as Error | undefined)?.name}, status=${ctx.agents.get('agent.coder').status}`)
        check('E4f 已取消的旧运行不会写出最终产物',
          readdirSync(r.root).filter((name) => name.startsWith('artifact-')).length === artifactCountBeforeCancel)
      } finally {
        globalThis.setInterval = nativeSetInterval
      }

      let staleAnalystReported = false
      let analystLedgerCleared = false
      Object.assign(ctx, {
        context: { assemble: async () => ({ system: '测试上下文', history: [], memories: [], retrieval: [] }) },
        orchestrator: {
          reportAgentResult: () => { staleAnalystReported = true; throw new Error('不应回报撤回任务') },
          cancelDelegatedTask: () => { analystLedgerCleared = true; return true },
        },
      })
      const analystRequestsBefore = mock.requests
      ctx.emit('orchestrator/delegate', {
        sessionId: 's_cancel', eventId: 'evt_cancel_analyst', target: '需求分析师', instruction: '撤回时中止会议分析',
      })
      for (let i = 0; i < 100 && mock.requests === analystRequestsBefore; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const cancelledAnalysts = await ctx.agentRuntime.cancelBySource('evt_cancel_analyst')
      check('E4g catalog Agent 经通用 dispatcher 进入取消屏障，取消后不回报旧结果',
        cancelledAnalysts === 1 && analystLedgerCleared && !staleAnalystReported,
        `count=${cancelledAnalysts}, cleared=${analystLedgerCleared}, reported=${staleAnalystReported}`)

      mock.mode = 'long-stream'
      const longSource = 'evt_long_stream'
      const longReceipt = await ctx.agentRuntime.perform('agent.coder', 'MOCK-长回复流', {
        sessionId: 's_progress', sourceEventId: longSource,
      })
      const longProgress = progressEvents.filter((event) => event.sourceEventId === longSource && event.phase === 'text-delta')
      const longDeltas = longProgress.map((event) => event.delta ?? '').join('')
      check('E4h 18,000 字符流式答复完整抵达运行时进度和最终回执',
        longDeltas.length === 18_000 && longReceipt.receipt.includes(longDeltas) && longProgress.length === 3,
        `delta=${longDeltas.length}，frames=${longProgress.length}，receipt=${longReceipt.receipt.length}`)
      check('E4i 超长答复完整写入工作区产物',
        readFileSync(join(longReceipt.root, longReceipt.files.at(-1)!), 'utf8').includes(longDeltas))

      mock.mode = 'stream-drop'
      const droppedSource = 'evt_stream_drop'
      const eventsBeforeDrop = ctx.eventLog.listBySession('s_progress').length
      let droppedError: unknown
      try {
        await ctx.agentRuntime.perform('agent.coder', 'MOCK-流中断', {
          sessionId: 's_progress', sourceEventId: droppedSource,
        })
      } catch (error) { droppedError = error }
      const droppedProgress = progressEvents.filter((event) => event.sourceEventId === droppedSource)
      const dropChecks = {
        errorCode: (droppedError as { code?: string } | undefined)?.code,
        partialDelta: droppedProgress.find((event) => event.phase === 'text-delta')?.delta,
        finalPhase: droppedProgress.at(-1)?.phase,
        agentStatus: ctx.agents.get('agent.coder').status,
        newTimelineEvents: ctx.eventLog.listBySession('s_progress').length - eventsBeforeDrop,
      }
      check('E4j SSE 断流保留部分预览、发出失败终态且不提交回执',
        dropChecks.errorCode === 'http_error' && dropChecks.partialDelta === '已生成但未提交' &&
          dropChecks.finalPhase === 'failed' && dropChecks.agentStatus === 'idle' && dropChecks.newTimelineEvents === 0,
        JSON.stringify(dropChecks))
      check('E4k 失败异常保留可持久化工作记录且原错误码不变',
        droppedError instanceof AgentExecutionFailureError &&
          droppedError.worklog.some((step) => step.label === '执行失败') &&
          droppedError.worklog.some((step) => step.label === '正在生成回复') &&
          droppedError.worklog.find((step) => step.label === '执行失败')?.status === 'failed' &&
          /LLM 流式读取失败/u.test(droppedError.worklog.find((step) => step.label === '执行失败')?.detail ?? '') &&
          droppedError.code === 'http_error',
        JSON.stringify({ error: droppedError?.constructor?.name, code: (droppedError as { code?: string })?.code,
          worklog: (droppedError as AgentExecutionFailureError | undefined)?.worklog }))
      rmSync(tmp, { recursive: true, force: true })
      db.close()
    }

    // E5 无 key → perform 占位模式（诚实标注【占位】，绝不冒充真模型）。
    {
      clearEnv()
      const tmp = mkdtempSync(join(tmpdir(), 'p8-llm-c-'))
      const db = memoryDb(true)
      const ctx = new Context()
      new SqlitePromptStore(ctx, db)
      new SqliteSettingsStore(ctx, db)
      applyCatalogAgents(ctx, db)
      new CommandService(ctx)
      new LocalWorkdirService(ctx, tmp)
      new OpenAiChatLlm(ctx)
      runtimeApply(ctx)
      agentDispatcherApply(ctx)
      const r = await ctx.agentRuntime.perform('agent.coder', 'MOCK-占位任务')
      check('E5 无 LLM → 占位模式诚实标注（mode=stub、含【占位】、无【真模型】、model=null）',
        r.mode === 'stub' && r.receipt.includes('【占位】') && !r.receipt.includes('【真模型】') && r.model === null,
        r.receipt)
      check('E5b 占位模式仍将任务文件归档到独立任务目录',
        r.files.length === 1 && r.files[0]!.startsWith('tasks/') && r.files[0]!.endsWith('/task.md'))
      rmSync(tmp, { recursive: true, force: true })
      db.close()
    }
  } finally {
    server.close()
    // env 还原（不留探针残留；saved 全为 undefined → 等价于再清一遍）
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // 门禁确定性（P8 下半场）：不管外层 shell 有没有真 key，A–D 一律占位模式
  // —— 先清 LLM 三件套；Part E 自管 env（注入 mock 三件套并在 finally 还原）。
  for (const k of [LLM_API_KEY_ENV, LLM_BASE_URL_ENV, LLM_MODEL_ENV]) delete process.env[k]
  console.log(`verify-p8：P8 机制层验收（提示词 + 大脑 + 建会名册 + catalog Agent + LLM 接入；断言 ⑬）`)
  await partA()
  await partB()
  await partC()
  await partD()
  await partE()
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
//   覆盖说明：Agent 动态创建与共享目录行为由 verify:agent-teamspace 覆盖；
//   本脚本验证 catalog Agent 的通用委托和运行路径。
//
//   ── P8 下半场红测（2026-09-30 实测）──────────────────────────────────
//   改坏方式：LLM_SABOTAGE=1 npm run verify:p8（agent-runtime 内置探针：
//   真模型模式把回执谎报为【占位】、mode 字段谎报 'stub' —— 诚实标注被改坏）。
//   实测结果：E4a 红（见下），退出码 1；还原（不设 env）复绿全过。
//   门禁不依赖真 key 的实现：main() 清 LLM 三件套（A–D 恒占位）+ Part E
//   进程内 mock OpenAI 兼容服务（node:http，端口 0，无子进程）自管 env。
//   另：verify-orchestrator Part B（对 live 服务端）同轮放宽为「双真大脑
//   合法终态」（await_human 静止 / 合法委托 chain）—— 用户填 key 后 live
//   大脑是 brain-llm，两种诚实终态都必须绿（记账在 verify-orchestrator 头注）。
