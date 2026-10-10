// ui-verify.mjs —— 团队空间页回归自测 + 会红断言（自用，不进 gate）。
// 断言区（AS1~AS4）任何一条不满足 → 输出 RED，进程退出码 1。
// Playwright 使用标准浏览器缓存；自定义浏览器路径通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定。
import { chromium } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
const envPath = new URL('../.env', import.meta.url)
const envSource = readFileSync(existsSync(envPath) ? envPath : new URL('../.env.example', import.meta.url), 'utf8')
const teamspacePort = process.env.TEAMSPACE_PORT ?? envSource.match(/^TEAMSPACE_PORT=(\d+)\s*$/m)?.[1]
if (!teamspacePort || Number(teamspacePort) < 1 || Number(teamspacePort) > 65535) {
  throw new Error('TEAMSPACE_PORT 缺失或无效；请在 .env 中配置唯一监听端口')
}
const teamspaceBase = `http://127.0.0.1:${teamspacePort}`
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
  : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e).slice(0, 150)))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 150)) })
await page.goto(`${teamspaceBase}/teamspace`, { waitUntil: 'networkidle', timeout: 20000 })
if (!(await page.locator('textarea').count())) {
  // 直接运行也可自举隔离账号，不要求操作者先手工登录。
  const username = 'ui_verify_gate'
  const password = 'UiVerify-pass-1'
  await page.goto(`${teamspaceBase}/login`, { waitUntil: 'networkidle', timeout: 20000 })
  await page.getByRole('tab', { name: '注册' }).click()
  await page.getByPlaceholder('用户名（登录用，全库唯一）').fill(username)
  await page.locator('input[type="password"]:visible').fill(password)
  await page.getByPlaceholder('显示名（会话里的称呼，可留空）').fill('UI 验收')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  try {
    await page.waitForURL('**/teamspace', { timeout: 3000 })
  } catch {
    // Reuse the deterministic verification account on subsequent runs.
    await page.getByRole('tab', { name: '登录' }).click()
    await page.getByPlaceholder('用户名', { exact: true }).fill(username)
    await page.locator('input[type="password"]:visible').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/teamspace', { timeout: 15000 })
  }
}
// This browser suite checks layout against the large seeded demo transcript.
// Add its deterministic test account as a member in the local test database so
// the new invitation boundary is exercised instead of bypassed by a public read.
{
  const token = await page.evaluate(() => localStorage.getItem('space_token'))
  if (!token) throw new Error('UI 验收账号缺少登录 token')
  const db = new DatabaseSync('data/database.db')
  try {
    const user = db.prepare('SELECT user_id FROM login_tokens WHERE token = ?').get(token)
    if (!user?.user_id) throw new Error('UI 验收 token 未关联 Team 账号')
    const session = db.prepare("SELECT id FROM sessions WHERE id = 's_seed_demo'").get()
    if (!session?.id) throw new Error('UI 验收需要已迁移并 seed 的 s_seed_demo 会话')
    db.prepare(`INSERT INTO session_members(session_id, principal_id, role, status, joined_at, left_at, duty)
      VALUES (?, ?, '成员', 'active', ?, NULL, '')
      ON CONFLICT(session_id, principal_id) DO UPDATE SET status='active', left_at=NULL`).run(
      session.id, user.user_id, new Date().toISOString(),
    )
  } finally { db.close() }
  await page.goto(`${teamspaceBase}/teamspace`, { waitUntil: 'networkidle', timeout: 20000 })
}
if (!(await page.locator('textarea').count())) throw new Error('登录后未进入 Teamspace 消息输入区')
await page.waitForTimeout(2500)
const ta = page.locator('textarea')
const reds = []
const judge = (name, ok, detail) => { console.log(`[AS] ${name}: ${ok ? 'GREEN' : 'RED'} —— ${detail}`); if (!ok) reds.push(name) }

console.log('== 常规回归（草稿 / 菜单 / 抽屉 / 消息卡）==')
await ta.fill('回归草稿，不发送')
console.log('草稿输入:', JSON.stringify(await ta.inputValue()))
await ta.fill('')
await ta.fill(''); await ta.pressSequentially('@a', { delay: 40 }); await page.waitForTimeout(400)
await ta.press('Enter'); await page.waitForTimeout(400)
console.log('@ 菜单 Enter 确认:', JSON.stringify(await ta.inputValue()))
await ta.fill(''); await ta.pressSequentially('/', { delay: 40 }); await page.waitForTimeout(400)
const mb = page.locator('.el-popover:visible .el-button')
const n = await mb.count()
let prim = 0; for (let i = 0; i < n; i++) if ((await mb.nth(i).getAttribute('class')).includes('--primary')) prim++
console.log('slash 菜单打开时常亮主色项(应0):', prim)
await mb.first().click(); await page.waitForTimeout(300)
console.log('点选补全:', JSON.stringify(await ta.inputValue()))
await page.keyboard.press('Escape')
console.log('k-card 质感:', await page.locator('.main-content .k-card').count(), '| 整行 alert(应0):', await page.locator('.main-content .el-alert').count())
console.log('行内回执/暂存轻量形态存在:', await page.locator('.main-content .k-card .el-tag').count() >= 0)

console.log('== 断言区 ==')
// AS1 Shift+Enter 恒换行（真实键盘 + 合成注入 双路径都必须出 \n）
{
  let ok = true; const detail = []
  try {
    await ta.fill(''); await ta.click()
    await ta.pressSequentially('K1', { delay: 25 })
    await ta.press('Shift+Enter'); await page.waitForTimeout(200)
    await ta.pressSequentially('K2', { delay: 25 })
    const v1 = await ta.inputValue()
    const realOk = v1 === 'K1\nK2'
    detail.push(`真实键盘=${JSON.stringify(v1)}(${realOk ? '含\\n' : '无\\n'})`)
    ok &&= realOk
    await ta.fill('SY1'); await ta.click()
    await page.evaluate(() => { document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })) })
    await page.waitForTimeout(300)
    const v2 = await ta.inputValue()
    const synOk = v2 === 'SY1\n'
    detail.push(`合成注入=${JSON.stringify(v2)}(${synOk ? '含\\n' : '无\\n'})`)
    ok &&= synOk
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 80)) }
  judge('AS1 Shift+Enter 恒换行(双路径)', ok, detail.join(' | '))
}

// AS2 时间线：消息行有稳定事件 ID，作者和时间元数据随消息可见。
{
  let ok = true; const detail = []
  try {
    const rows = page.locator('.sp-list .sp-msg[data-ev-id]')
    const count = await rows.count()
    const text = count ? await rows.first().innerText() : ''
    const hasTimestamp = /\d{2}:\d{2}(?::\d{2})?/.test(text)
    const hasAuthor = Boolean(await rows.first().locator('.sp-msg-name').textContent().catch(() => ''))
    detail.push(`稳定消息行=${count > 0} 作者=${hasAuthor} 时间=${hasTimestamp}`)
    ok &&= count > 0 && hasAuthor && hasTimestamp
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 80)) }
  judge('AS2 消息时间线显示作者、时间与稳定事件行', ok, detail.join(' | '))
}

// AS3 折叠（弃动画拍板后）：点击即折叠/展开（无过渡机制残留）+ 折叠态 10 步交互
// 真实浏览器计时，任何一步 >1s 判红（卡顿一票否决的量化形态）。
{
  let ok = true; const detail = []
  try {
    const toggle = page.locator('.layout-header button').first()
    await toggle.click(); await page.waitForTimeout(150)
    const collapsed = (await page.locator('aside.page-sidebar').count()) === 0
    detail.push(`点击后150ms内已折叠=${collapsed}`)
    ok &&= collapsed
    await toggle.click(); await page.waitForTimeout(150)
    const expanded = (await page.locator('aside.page-sidebar').count()) === 1
    detail.push(`再点150ms内已展开=${expanded}`)
    ok &&= expanded
    const machinery = await page.evaluate(() => {
      const a = document.querySelector('aside.page-sidebar')
      return a ? (a.style.maxHeight !== '' || a.className.includes('collapse-transition')) : false
    })
    detail.push(`过渡机制残留=${machinery}(应false)`)
    ok &&= !machinery
    await toggle.click(); await page.waitForTimeout(150) // 进入折叠态
    const ta2 = page.locator('textarea')
    const steps = []
    const run = async (name, fn) => { const s0 = performance.now(); await fn(); steps.push([name, Math.round(performance.now() - s0)]) }
    await run('1toggle展开', () => toggle.click())
    await run('2toggle折叠', () => toggle.click())
    await run('3textarea填充', () => ta2.fill('延迟探针'))
    await run('4读值', () => ta2.inputValue())
    await run('5抽屉开', async () => { await page.locator('.layout-header button:has-text("协作面板")').click(); await page.waitForTimeout(80) })
    await run('6抽屉关', async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(80) })
    await run('7toggle展开', () => toggle.click())
    await run('8toggle折叠', () => toggle.click())
    await run('9toggle展开', () => toggle.click())
    await run('10悬停消息', () => page.locator('.sp-list .sp-msg[data-ev-id]').first().hover())
    const maxMs = Math.max(...steps.map((x) => x[1]))
    detail.push(`10步耗时=${JSON.stringify(steps.map((x) => x[1]))}ms max=${maxMs}ms`)
    ok &&= maxMs < 1000
    await toggle.click(); await page.waitForTimeout(150) // 恢复展开态
    // Do not leave the interaction probe in the composer shown in the final screenshot.
    await page.locator('textarea').fill('')
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 80)) }
  judge('AS3 折叠即时可靠+折叠态10步交互<1s', ok, detail.join(' | '))
}

// AS4 活动 Tab 分批渲染：大历史会话先显示最新 100 条，按需加载更早记录。
{
  let ok = true; const detail = []
  try {
    if (!(await page.locator('.right-sidebar').count())) {
      await page.locator('.layout-header button:has-text("协作面板")').click()
    }
    const activityTab = page.locator('.right-sidebar .el-tabs__item').nth(1)
    await activityTab.click()
    const total = Number((await activityTab.innerText()).match(/\((\d+)\)/)?.[1] ?? 0)
    const cards = page.locator('.right-sidebar .el-card')
    const firstBatch = await cards.count()
    detail.push(`总数=${total} 初始卡片=${firstBatch}`)
    // 额外卡片可能是正在运行的 Agent 进度卡，不属于历史活动批次。
    ok &&= firstBatch <= 110
    const more = page.getByRole('button', { name: /加载更早活动/ })
    if (total > firstBatch) {
      ok &&= await more.count() === 1
      await more.click()
      const nextBatch = await cards.count()
      detail.push(`加载后卡片=${nextBatch}`)
      ok &&= nextBatch - firstBatch === 100 && nextBatch <= 210
    }
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  judge('AS4 活动日志按需分批渲染', ok, detail.join(' | '))
}

// AS5 窄屏：会话标题不换行，搜索控件始终处于视口内且输入框保留可用宽度。
{
  let ok = true; const detail = []
  try {
    const token = await page.evaluate(() => localStorage.getItem('space_token'))
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await mobileContext.addInitScript((value) => localStorage.setItem('space_token', value), token)
    const mobile = await mobileContext.newPage()
    const mobileErrors = []
    mobile.on('pageerror', (e) => mobileErrors.push(String(e).slice(0, 100)))
    await mobile.goto(`${teamspaceBase}/teamspace`, { waitUntil: 'networkidle', timeout: 20000 })
    await mobile.locator('.sp-session-title').waitFor({ timeout: 10000 })
    await mobile.waitForTimeout(500)
    const layout = await mobile.evaluate(() => {
      const title = document.querySelector('.sp-session-title')
      const search = document.querySelector('.sp-search-input')
      const panelToggle = document.querySelector('.sp-collab-toggle')
      const titleRect = title?.getBoundingClientRect()
      const searchRect = search?.getBoundingClientRect()
      const panelRect = panelToggle?.getBoundingClientRect()
      return {
        titleWhiteSpace: title ? getComputedStyle(title).whiteSpace : '',
        titleHeight: titleRect?.height ?? 0,
        titleWidth: titleRect?.width ?? 0,
        panelText: panelToggle?.textContent?.trim() ?? '',
        panelRight: panelRect?.right ?? Infinity,
        searchLeft: searchRect?.left ?? 0,
        searchRight: searchRect?.right ?? Infinity,
        searchWidth: searchRect?.width ?? 0,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }
    })
    detail.push(`标题=${layout.titleWhiteSpace}/${layout.titleWidth}×${layout.titleHeight}px`)
    detail.push(`面板按钮=${layout.panelText}，右边界=${layout.panelRight}/${layout.viewportWidth}px`)
    detail.push(`搜索宽=${layout.searchWidth}px，右边界=${layout.searchRight}/${layout.viewportWidth}px，页面宽=${layout.documentWidth}px`)
    ok &&= layout.titleWhiteSpace === 'nowrap' && layout.titleHeight <= 32 && layout.titleWidth >= 80
    ok &&= layout.panelText === '面板' && layout.panelRight <= layout.viewportWidth
    ok &&= layout.searchWidth >= 150 && layout.searchRight <= layout.viewportWidth && layout.documentWidth <= layout.viewportWidth
    ok &&= mobileErrors.length === 0
    await mobile.screenshot({ path: '/tmp/ui-mobile-final.png' })
    await mobileContext.close()
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  judge('AS5 390px 标题与搜索栏不换行/不溢出', ok, detail.join(' | '))
}

console.log('页面错误:', errs.length ? errs : '（无）')
await page.screenshot({ path: '/tmp/ui-final.png' })
await browser.close()
console.log(`断言汇总: ${reds.length ? 'RED → ' + reds.join(', ') : '全部 GREEN'}`)
process.exitCode = reds.length ? 1 : 0
