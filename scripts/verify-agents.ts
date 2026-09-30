// verify-agents.ts —— P6 端到端验收（第十一门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 6 节断言 ⑪ + 铁律 4（IRON-RULES.md）。
//   Part C（静态扫描，断言 ⑪ 判红器）：**入驻白名单** —— agent 特判（具体 agent id
//     引用、kind === 'coding'/'meeting' 字面比较）只准出现在 agent 白名单路径
//     （seam/space-agent、impl|policy/space-agent-*、bundle/space-agent-*、
//     plugins/agent-*、本脚本）。核心文件 / 会议链路里出现 = 判红
//     （红测：往 orchestrator 里塞一行 agent 特判 → 这里红）。
//   Part A（进程内，不需要服务）：注册表语义逐条对拍 —— 注册期防呆（空 id/title、
//     非法 kind、重名即炸）、报到即 idle、list 排序与 kind 过滤、状态机白名单
//     （合法链 / 非法迁移）、心跳、退驻与重开、/tell 直派语义（正常回执 /
//     未入驻必带可用清单 / 会议机器人拒收 / 非 @ 开头 / 正忙不接单）。
//   Part B（对运行中的后端）：HTTP 面接线 —— /tell @名字、@id、未知清单、
//     非 / 消息仍走暂存（**开会功能不回退**的直观测点）。
//
// 前提：后端已在 APP_PORT 运行（与 verify:staging 同前提，gate 顺序保证）。
// 用法：npm run verify:agents    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-agents（断言 ⑨）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AgentError } from 'space-agent'
import { CommandError, parse } from 'space-command'
import type { CommandCtx } from 'space-command'
import { CommandService } from 'space-command'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { apply as stubApply } from '../plugins/agent-coder-stub/index.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 断言器 ────────────────────────────────────────────────────────────────
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
async function expectError(name: string, code: string, fn: () => unknown): Promise<void> {
  try {
    await fn()
    check(name, false, `期望抛 ${code}，但没有抛`)
  } catch (e) {
    const got = e instanceof CommandError || e instanceof AgentError ? e.code : String((e as Error).message)
    check(name, got === code, `期望 ${code}，实际 ${got}`)
  }
}

// ── 端口：.env 唯一出处 ──────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════
// Part C —— 入驻白名单静态扫描（断言 ⑪ 的判红器）
// ══════════════════════════════════════════════════════════════════════════

/** agent 特判只准住这些路径前缀里（铁律 4：入驻 = 纯新增，不开后门）。 */
const WHITELIST_PREFIXES = [
  'packages/seam/space-agent/',
  'packages/impl/space-agent-',
  'packages/policy/space-agent-',
  'packages/bundle/space-agent-',
  'plugins/agent-',
  'scripts/verify-agents.ts',
  'scripts/verify-workdir.ts',
]
/** 扫描范围：业务源码 + 脚本（node_modules/dist/产物不扫）。 */
const SCAN_ROOTS = ['src', 'plugins', 'packages', 'scripts', 'config']
const SCAN_EXTS = new Set(['.ts', '.sh', '.yml', '.yaml', '.json'])
/** 「agent 特判」的形状：具体 agent id 字面量 / kind 字面比较。 */
const AGENT_COUPLE_PATTERNS: [RegExp, string][] = [
  [/['"]agent\.[a-z0-9_-]+['"]/, '具体 agent id 字面量'],
  [/kind\s*===?\s*['"](coding|meeting)['"]/, 'kind 字面比较'],
]

function walkFiles(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue
      walkFiles(p, out)
    } else if (e.isFile() && SCAN_EXTS.has(extname(e.name))) {
      out.push(p)
    }
  }
}

function partC(): void {
  section('Part C：入驻白名单扫描（断言 ⑪：agent 特判只准住在 agent 包里）')
  // 模块目录是 scripts/，仓库根是其父级（红测①教训：根错位 = 扫空集 = 空断言）
  const root = resolve(import.meta.dirname ?? '.', '..')
  const files: string[] = []
  for (const d of SCAN_ROOTS) {
    const abs = resolve(root, d)
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue
    walkFiles(abs, files)
  }
  let hits = 0
  for (const f of files) {
    const rel = relative(root, f).replaceAll('\\', '/')
    if (WHITELIST_PREFIXES.some((w) => rel.startsWith(w))) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const [re, what] of AGENT_COUPLE_PATTERNS) {
        if (re.test(lines[i]!)) {
          hits++
          console.log(`  ✗ 白名单外 agent 特判：${rel}:${i + 1}（${what}）→ ${lines[i]!.trim().slice(0, 80)}`)
        }
      }
    }
  }
  check('C1 全部 agent 特判都在白名单路径内', hits === 0, `白名单外命中 ${hits} 处`)
}

// ══════════════════════════════════════════════════════════════════════════
// Part A —— 进程内机制断言（真注册表 + 真指令缝 + 真 stub 插件 apply）
// ══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  section('Part A：进程内机制断言（AgentRegistry + /tell）')

  const ctx = new Context()
  const agents = new AgentRegistry(ctx) // 构造即 provide（承 ui-registry 同款）
  const commands = new CommandService(ctx)
  // P6 收尾：/tell 干活路径要领工作区（写文件级 stub）——harness 补临时目录 workdir
  const tmp = mkdtempSync(join(tmpdir(), 'agents-verify-'))
  new LocalWorkdirService(ctx, tmp)
  stubApply(ctx) // 报到（agent.coder）+ 注册 /tell —— 与运行时完全同一条路径

  const S = 's_a'
  const U = 'u_dri'
  const dispatch = (text: string) =>
    commands.dispatch({ sessionId: S, authorId: U, arg: '', args: [], raw: text } satisfies CommandCtx, parse(text)!)

  // A1 注册期防呆
  await expectError('A1a 空 id 即炸（not_found）', 'not_found', () =>
    agents.register({ id: '', kind: 'coding', title: 'x', capabilities: [] }))
  await expectError('A1b 非法 kind 即炸（invalid_kind）', 'invalid_kind', () =>
    agents.register({ id: 'agent.x', kind: 'robot' as never, title: 'x', capabilities: [] }))
  await expectError('A1c 空 title 即炸（not_found）', 'not_found', () =>
    agents.register({ id: 'agent.x', kind: 'coding', title: '', capabilities: [] }))
  await expectError('A1d 重复入驻即炸（duplicate_agent）', 'duplicate_agent', () =>
    agents.register({ id: 'agent.coder', kind: 'coding', title: '重名', capabilities: [] }))
  check('A1e 报到即 idle', agents.get('agent.coder').status === 'idle')

  // 会议机器人（测 kind 过滤与 /tell 拒收）
  agents.register({ id: 'agent.recorder', kind: 'meeting', title: '会议记录官', capabilities: ['minutes'] })

  // A2 list：按 id 排序 + kind 过滤
  const all = agents.list().map((s) => s.descriptor.id)
  check('A2a list 按 id 稳定排序', all.join(',') === 'agent.coder,agent.recorder', all.join(','))
  check('A2b list(kind) 过滤', agents.list('coding').length === 1 && agents.list('coding')[0]!.descriptor.id === 'agent.coder')

  // A3 状态机白名单（seam STATUS_TRANSITIONS 照表执法）
  agents.setStatus('agent.coder', 'working')
  agents.setStatus('agent.coder', 'done')
  agents.setStatus('agent.coder', 'idle')
  check('A3a 合法链 idle→working→done→idle 通过', agents.get('agent.coder').status === 'idle')
  await expectError('A3b 非法迁移 idle→done 判红（invalid_transition）', 'invalid_transition', () =>
    agents.setStatus('agent.coder', 'done'))
  agents.setStatus('agent.coder', 'working')
  await expectError('A3c 非法迁移 working→idle 判红（invalid_transition）', 'invalid_transition', () =>
    agents.setStatus('agent.coder', 'idle'))
  agents.setStatus('agent.coder', 'done')
  agents.setStatus('agent.coder', 'idle') // 还原

  // A4 心跳
  const before = agents.get('agent.coder').lastHeartbeatAt
  await new Promise((r) => setTimeout(r, 5))
  agents.heartbeat('agent.coder')
  const after = agents.get('agent.coder').lastHeartbeatAt
  check('A4a 心跳刷新 lastHeartbeatAt', after !== null && (before === null || after > before))
  await expectError('A4b 未知 agent 心跳即炸（not_found）', 'not_found', () => agents.heartbeat('agent.nobody'))

  // A5 退驻与重开
  await expectError('A5a 退驻未知 agent 即炸（not_found）', 'not_found', () => agents.unregister('agent.nobody'))
  agents.unregister('agent.recorder')
  agents.register({ id: 'agent.recorder', kind: 'meeting', title: '会议记录官', capabilities: ['minutes'] })
  check('A5b 退驻后可重新入驻（重开），状态回 idle', agents.get('agent.recorder').status === 'idle')

  // A6 get 未知
  await expectError('A6 get 未知 agent 即炸（not_found）', 'not_found', () => agents.get('agent.nobody'))

  // A7 /tell 正常：@名字直派 → 回执 + 状态归位
  const r1 = await dispatch('/tell @编码者 实现登录页')
  check('A7a /tell 回执含领任务与交付', r1.text.includes('已领任务：实现登录页') && r1.text.includes('回执'), r1.text)
  check('A7b /tell 后状态归位 idle（可领下一个）', agents.get('agent.coder').status === 'idle')

  // A8 未知 agent：必带可用清单
  try {
    await dispatch('/tell @不存在 干活')
    check('A8 未入驻直派判红', false, '没有抛错')
  } catch (e) {
    const msg = e instanceof CommandError ? e.message : String((e as Error).message)
    check('A8 未入驻直派判红且带可用清单', e instanceof CommandError && e.code === 'bad_args' && msg.includes('已入驻'), msg)
  }

  // A9 会议机器人拒收（开会不会被直派旁路 —— 铁律 4）
  try {
    await dispatch('/tell @会议记录官 写纪要')
    check('A9 会议机器人拒收', false, '没有抛错')
  } catch (e) {
    const msg = e instanceof CommandError ? e.message : String((e as Error).message)
    check('A9 会议机器人拒收并指路协调者', e instanceof CommandError && e.code === 'bad_args' && msg.includes('不接直派'), msg)
  }

  // A10 非 @ 开头
  await expectError('A10 目标非 @ 开头判红（bad_args）', 'bad_args', () => dispatch('/tell 编码者 干活'))

  // A11 正忙不接单（状态机天然防并发）
  agents.setStatus('agent.coder', 'working')
  try {
    await dispatch('/tell @编码者 加塞')
    check('A11 正忙拒收', false, '没有抛错')
  } catch (e) {
    const msg = e instanceof CommandError ? e.message : String((e as Error).message)
    check('A11 正忙拒收（working 不接单）', e instanceof CommandError && e.code === 'bad_args' && msg.includes('正忙'), msg)
  }
  agents.setStatus('agent.coder', 'done')
  agents.setStatus('agent.coder', 'idle') // 还原
  rmSync(tmp, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— HTTP 面接线（对运行中的后端）
// ══════════════════════════════════════════════════════════════════════════
async function partB(): Promise<void> {
  section('Part B：HTTP 面接线（POST /api/sessions/s_seed_demo/messages）')

  async function post(text: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/api/sessions/s_seed_demo/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, authorId: 'u_dri' }),
    })
    return { status: res.status, body: await res.json() }
  }

  // B1 @名字直派
  const b1 = await post('/tell @编码者 实现登录页')
  check('B1 /tell @名字 回执', b1.status === 200 && String(b1.body.reply ?? '').includes('已领任务：实现登录页'), JSON.stringify(b1.body))

  // B2 @id 直派
  const b2 = await post('/tell @agent.coder 写个单测')
  check('B2 /tell @id 回执', b2.status === 200 && String(b2.body.reply ?? '').includes('已领任务：写个单测'), JSON.stringify(b2.body))

  // B3 未知 agent → 400 + 可用清单
  const b3 = await post('/tell @不存在 干活')
  check('B3 未知 agent 400 且带可用清单', b3.status === 400 && String(b3.body.detail ?? '').includes('已入驻'), JSON.stringify(b3.body))

  // B4 开会功能不回退：非 / 消息仍自动暂存（铁律 4 不变式的直观测点）
  const b4 = await post('普通人类发言')
  check('B4 非 / 消息仍走暂存（开会路径无恙）', b4.status === 200 && String(b4.body.reply ?? '').includes('已记下'), JSON.stringify(b4.body))
  const b5 = await post('/clear confirm')
  check('B5 清理测试暂存（原 1 条）', b5.status === 200 && String(b5.body.reply ?? '').includes('已清空'), JSON.stringify(b5.body))
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(`verify-agents：P6 多智能体入驻端到端验收（APP_PORT=${PORT}）`)
  partC()
  await partA()
  await partB()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-agents 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-agents', '{"ok":true}'], { stdio: 'inherit' })
  console.log('✓ verify-agents 全过（断言留痕：action_log: verify-agents）')
}

await main()
