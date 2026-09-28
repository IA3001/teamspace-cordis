// verify-staging.ts —— P2 端到端验收（第七门禁，铁律 2：改坏必红）。
//
// 断言出处：dev-cordis/MODULE-PLAN.md 第 5 节 P2 行 + project_memory 硬约束。
//   Part A（进程内，不需要服务）：指令机制与暂存语义的逐条对拍 ——
//     注册期防呆（重名即炸 / usage 必填）、Parse 边界（行首 / 才认、大小写敏感）、
//     seq 自增不重排、只有作者能改/撤、未注册指令带可用清单、参数个数校验、
//     /clear 两段式、/commit 恰好一次 Plan（ctx.on('staging/plan') 订阅计数）。
//   Part B（对运行中的后端）：入站路由的接线 —— 非 / 消息自动暂存**不落事件**
//     （即不触发 Plan 的可观测面）、HTTP 错误形状、/clear 两段式、/commit 合并
//     成单条人类发言事件并清空暂存、空提交零事件。
//
// 前提：后端已在 APP_PORT 运行（与 check:console 同前提，gate 顺序保证）。
// 用法：npm run verify:staging    退出码 0 = 全过；1 = 判红。
// 留痕：全部通过后记一行 action_log: verify-staging（断言 ⑨）。
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { CommandError, parse } from 'space-command'
import { CommandService } from 'space-command'
import { StagingError } from 'space-staging'
import type { Command, CommandCtx } from 'space-command'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteStagingStore } from '../packages/impl/space-store-sqlite/src/staging.ts'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { registerCommands } from '../plugins/staging-commands/index.ts'

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
    const got = e instanceof CommandError || e instanceof StagingError ? e.code : String((e as Error).message)
    check(name, got === code, `期望 ${code}，实际 ${got}`)
  }
}

// ── 端口：.env 唯一出处（与 env.sh 同一来源，不在代码里写死）─────────────
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
// Part A —— 进程内机制断言（:memory: 库 + 真迁移链 + 真实现类）
// ══════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  section('Part A：进程内机制断言（:memory:）')

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const migrationsDir = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
  for (const m of loadMigrations(migrationsDir)) db.exec(m.up)
  db.prepare(
    `INSERT INTO sessions(id, title, status, created_at, updated_at)
     VALUES ('s_a', '验收A', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run()

  const ctx = new Context()
  const eventLog = new SqliteEventLog(ctx, db)
  const staging = new SqliteStagingStore(ctx, db, eventLog)
  const commands = new CommandService(ctx)
  registerCommands(commands, staging)

  // Plan 触发计数（验收「/commit 恰好一次 Plan」的直接观测点）：内核事件订阅
  let planCount = 0
  ctx.on('staging/plan', () => {
    planCount++
  })

  const S = 's_a'
  const U = 'u_dri'
  const W = 'u_other' // 另一个人（非作者）
  const dispatch = (text: string, authorId = U) =>
    commands.dispatch({ sessionId: S, authorId, arg: '', args: [], raw: text } satisfies CommandCtx, parse(text)!)

  // A1 注册期防呆：重名即炸（约束：重名是编程错误，注册期就炸）；usage 必填
  const dup: Command = { name: 'add', usage: 'dup', minArgs: 0, maxArgs: 0, run: () => ({ text: '' }) }
  await expectError('A1a 重名注册即炸（duplicate）', 'duplicate', () => commands.register(dup))
  await expectError(
    'A1b usage 为空即炸（usage 必填）',
    'duplicate',
    () => commands.register({ name: 'ghost', usage: '', minArgs: 0, maxArgs: 0, run: () => ({ text: '' }) }),
  )

  // A2 Parse 边界（承旧 Go Parse 口径）
  check('A2a 行首 / 才认（前导空白允许）', JSON.stringify(parse('  /del 2')) === JSON.stringify({ name: 'del', rest: '2' }))
  check('A2b 句中斜杠不误触发', parse('看看 /cur 在哪') === null)
  check('A2c 孤零零 / 按普通消息', parse('/') === null)
  check('A2d URL 里的斜杠不触发', parse('https://example.com/a/b') === null)
  check('A2e rest 保留原文空格', parse('/add 两  空格')?.rest === '两  空格')
  check('A2f 大小写敏感（/ADD ≠ /add）', parse('/ADD x')?.name === 'ADD')

  // A3 指令族与库态对拍（seq 自增、删除不重排）
  const r1 = await dispatch('/add 第一条')
  check('A3a /add 回执「已记下 #1（当前共 1 条）」', r1.text === '已记下 #1（当前共 1 条）', r1.text)
  const r2 = await dispatch('/add 第二条  保留空格')
  check('A3b /add 保留原文空格', staging.list(S)[1]!.text === '第二条  保留空格')
  check('A3c 回执计数正确', r2.text === '已记下 #2（当前共 2 条）', r2.text)
  await dispatch('/del 1')
  const cur = await dispatch('/cur')
  check('A3d /del 后 /cur 只剩 #2（seq 不重排）', cur.text.includes('#2 第二条  保留空格') && !cur.text.includes('#1'), cur.text)
  const r3 = await dispatch('/add 第三条')
  check('A3e 新条目取 max+1（#3，不回填 #1）', r3.text === '已记下 #3（当前共 2 条）', r3.text)

  // A4 只有作者能改/撤自己的条目（硬约束）
  await expectError('A4a 非作者 /del → not_author', 'not_author', () => dispatch('/del 2', W))
  await expectError('A4b 非作者 /change → not_author', 'not_author', () => dispatch('/change 2 别人的', W))
  await expectError('A4c 不存在的序号 → not_found', 'not_found', () => dispatch('/del 99'))

  // A5 未注册指令：错误必带可用清单（验收行原句）
  try {
    await dispatch('/noop')
    check('A5 未注册指令返回可用清单', false, '没有抛错')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check('A5 未注册指令返回可用清单', e instanceof CommandError && e.code === 'unknown' && msg.includes('/cur') && msg.includes('/commit'), msg)
  }

  // A6 参数个数校验（minArgs / maxArgs）
  await expectError('A6a /del 缺参 → bad_args', 'bad_args', () => dispatch('/del'))
  await expectError('A6b /change 缺文本 → bad_args', 'bad_args', () => dispatch('/change 2'))
  await expectError('A6c /commit 多参 → bad_args', 'bad_args', () => dispatch('/commit extra'))
  await expectError('A6d /cur 多参 → bad_args', 'bad_args', () => dispatch('/cur x'))

  // A7 /clear 两段式（承旧面板契约）
  const c1 = await dispatch('/clear')
  check('A7a 第一段只给确认话术', c1.text.includes('确认') && c1.text.includes('/clear confirm'), c1.text)
  check('A7b 第一段没真清（仍 2 条）', staging.count(S) === 2)
  const c2 = await dispatch('/clear confirm')
  check('A7c /clear confirm 才真清', c2.text === '已清空（原 2 条）' && staging.count(S) === 0, c2.text)

  // A8 /commit 恰好一次 Plan（验收行原句）—— 到此为止只有暂存动作，零信号
  check('A8a 暂存动作不触发 Plan', planCount === 0, `planCount=${planCount}`)
  await dispatch('/add 甲')
  await dispatch('/add 乙')
  const cm = await dispatch('/commit')
  check('A8b /commit 回执「已提交 2 条发言」', cm.text === '已提交 2 条发言（事件 seq=1）', cm.text)
  check('A8c 成功 /commit 恰好一次 Plan', planCount === 1, `planCount=${planCount}`)
  const evs = eventLog.listBySession(S)
  check(
    'A8d 合并成一条人类发言（换行拼接、落 events）',
    evs.length === 1 && evs[0]!.authorKind === 'human' && evs[0]!.kind === 'message' && evs[0]!.text === '甲\n乙',
    JSON.stringify(evs.map((e) => [e.authorKind, e.kind, e.text])),
  )
  check('A8e 提交后暂存区清空', staging.count(S) === 0)
  const cm2 = await dispatch('/commit')
  check('A8f 空 /commit 只回执、零事件零信号', cm2.text.includes('暂存区为空') && planCount === 1 && eventLog.lastSeq(S) === 1, `${cm2.text} planCount=${planCount}`)
  await dispatch('/add 丙')
  await dispatch('/commit')
  check('A8g 第二次成功 commit → 第二次信号（恰好一次/每次）', planCount === 2 && eventLog.lastSeq(S) === 2, `planCount=${planCount}`)

  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
// Part B —— 对运行中的后端做接线断言（HTTP + 直查库）
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

async function getStaging(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/api/sessions/${S}/staging`)
  return (await res.json()) as Array<Record<string, unknown>>
}

function openDb(): DatabaseSync {
  return new DatabaseSync(new URL('../data/database.db', import.meta.url).pathname)
}

function eventsCount(db: DatabaseSync): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM events WHERE session_id = ?`).get(S)!.n)
}

async function partB(): Promise<void> {
  section(`Part B：接线断言（${BASE}，会话 ${S}）`)

  // B0 服务可达（不可达 = 门禁前提不满足，明确判红并给指引）
  let alive = false
  try {
    alive = (await fetch(`${BASE}/healthz`)).ok
  } catch {
    alive = false
  }
  check('B0 后端可达（/healthz）', alive, `连不上 ${BASE} —— 先 npm run start（verify 与 check:console 同前提）`)
  if (!alive) return

  const db = openDb()

  // B1 非 / 消息：自动入暂存区、不落事件（= 不触发 Plan 的可观测面）
  const before = eventsCount(db)
  const b1 = await post('帮我看下这段需求的边界条件（verify B1）')
  const after = eventsCount(db)
  check('B1a 回执「已记下 #N」', b1.status === 200 && String(b1.body.reply ?? '').startsWith('已记下 #'), JSON.stringify(b1.body))
  check('B1b 没有落事件（不触发 Plan）', after === before, `events ${before} → ${after}`)
  const staged = await getStaging()
  check('B1c 暂存区里能查到这条', staged.some((e) => String(e.text) === '帮我看下这段需求的边界条件（verify B1）'))

  // B2 未注册指令：400 + 可用清单
  const b2 = await post('/noop 玩笑')
  check(
    'B2 未注册指令 → 400，detail 带可用清单',
    b2.status === 400 && String(b2.body.detail ?? '').includes('/commit'),
    JSON.stringify(b2.body),
  )

  // B3 /clear 两段式（HTTP 面）
  const b3a = await post('/clear')
  const nAfterFirst = (await getStaging()).length
  check('B3a 第一段只给确认话术', String(b3a.body.reply ?? '').includes('确认'), JSON.stringify(b3a.body))
  check('B3b 第一段没真清', nAfterFirst > 0 || String(b3a.body.reply ?? '').includes('0 条'))
  const b3b = await post('/clear confirm')
  check('B3c confirm 才真清', String(b3b.body.reply ?? '').startsWith('已清空') && (await getStaging()).length === 0, JSON.stringify(b3b.body))

  // B4 /commit：合并成单条人类发言事件 + 清空暂存
  await post('/add b4-one')
  await post('/add b4-two')
  const eb = eventsCount(db)
  const b4 = await post('/commit')
  const ea = eventsCount(db)
  check('B4a 回执「已提交 2 条」', b4.status === 200 && String(b4.body.reply ?? '').includes('已提交 2 条'), JSON.stringify(b4.body))
  check('B4b events 恰好多 1 条', ea === eb + 1, `${eb} → ${ea}`)
  const last = db
    .prepare(`SELECT author_kind, kind, text FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(S) as { author_kind: string; kind: string; text: string }
  check('B4c 合并文本 = 两行拼接、human/message', last.text === 'b4-one\nb4-two' && last.author_kind === 'human' && last.kind === 'message', JSON.stringify(last))
  check('B4d 提交后暂存区清空', (await getStaging()).length === 0)

  // B5 空提交：只回执，不落事件
  const eb5 = eventsCount(db)
  const b5 = await post('/commit')
  check('B5 空 /commit 回执且零事件', b5.status === 200 && String(b5.body.reply ?? '').includes('暂存区为空') && eventsCount(db) === eb5, JSON.stringify(b5.body))

  db.close()
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log(`verify-staging：P2 暂存区指令族端到端验收（APP_PORT=${PORT}）`)
  await partA()
  await partB()
  console.log(`\n结果：${passes} 过 / ${failures} 红`)
  if (failures > 0) {
    console.log('✗ verify-staging 判红 —— 改坏了（铁律 2：断言必须能红）')
    process.exit(1)
  }
  execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-staging', '{"ok":true}'], { stdio: 'inherit' })
  console.log('✓ verify-staging 全过（断言留痕：action_log: verify-staging）')
}

await main()
