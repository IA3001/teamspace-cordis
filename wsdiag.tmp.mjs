import { chromium } from 'playwright-core'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('websocket', ws => {
  ws.on('framereceived', f => {
    const t = f.payload?.toString?.() ?? ''
    if (t.includes('login') || t.includes('error')) console.log('[ws←]', t.slice(0, 300))
  })
  ws.on('framesent', f => {
    const t = f.payload?.toString?.() ?? ''
    if (t.includes('login')) console.log('[ws→]', t.slice(0, 200))
  })
})
await page.goto('http://localhost:5172/admin', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(2000)
await page.locator('input[placeholder="管理员用户名"]').first().fill('xiaolin')
await page.locator('input[placeholder="密码"]').first().fill('pass-123456')
await page.locator('button:has-text("登录并进入账号管理")').first().click()
await page.waitForTimeout(3000)
console.log('[token]', (await page.evaluate(() => localStorage.getItem('space_token')))?.slice(0, 10))
await browser.close()
