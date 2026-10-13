// interact-test.mjs —— 联想菜单交互自测：/ 指令联想 + @ 成员联想（自用）。
//
// 依赖前置（2026-10-01 修复裸报错）：playwright-core 不在 package.json
// 依赖里（可选工具），缺依赖时给一句话指引而不是 Cannot find package 堆栈。
let chromium
try {
  ;({ chromium } = await import('playwright-core'))
} catch {
  console.error('✗ 缺少 playwright-core —— 先执行：npm i -D playwright-core')
  process.exit(1)
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:5174/teamspace', { waitUntil: 'networkidle', timeout: 20000 })
// IM 化后未登录会跳 /login —— 提示先在浏览器里登录（token 在 localStorage/cookie）。
if (page.url().includes('/login')) {
  console.error('✗ 未登录 —— 先在浏览器打开 5174 登录一次，再跑本脚本（同一浏览器上下文才有 token）。')
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(2000)
const ta = page.locator('textarea')

// 1. 输入 "/" 作为普通文本，不展示命令菜单
await ta.fill('')
await ta.pressSequentially('/', { delay: 50 })
await page.waitForTimeout(400)
console.log('命令菜单关闭:', await page.locator('.el-popover:visible').count() === 0)
console.log('斜杠保留为草稿:', JSON.stringify(await ta.inputValue()) === '/')

// 2. 继续输入仍作为普通草稿
await ta.pressSequentially('c', { delay: 50 })
await page.waitForTimeout(300)
console.log('普通草稿:', JSON.stringify(await ta.inputValue()))

// 3. 清空后继续验证 @成员联想
await ta.fill('')
await ta.pressSequentially('@a', { delay: 50 })
await page.waitForTimeout(300)
console.log('@ 联想菜单条数:', await page.locator('.el-popover:visible .el-button').count())

// 4. @ 联想过滤 + 点选
await ta.fill('')
await ta.pressSequentially('@a', { delay: 50 })
await page.waitForTimeout(400)
console.log('mention 过滤后含 a_analyst:', await page.getByText('需求分析师（a_analyst）').count() > 0, '| 不含 recorder:', await page.locator('.el-card__body div:has(> .el-tag)').filter({ hasText: '会议记录官' }).count())
await page.screenshot({ path: '/tmp/p4-mention.png' })
await browser.close()
console.log('saved /tmp/p4-mention.png')
