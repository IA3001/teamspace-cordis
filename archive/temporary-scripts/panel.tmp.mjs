import { chromium } from 'playwright-core'
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync('data/database.db', { readOnly: true })
const token = db.prepare('SELECT token FROM login_tokens ORDER BY created_at DESC LIMIT 1').get().token
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)))
await page.addInitScript(t => localStorage.setItem('space_token', t), token)
await page.goto('http://localhost:5174/teamspace', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(3000)
const panel = page.locator('.right-sidebar .el-card').last()
if ((await panel.count()) > 0) await panel.screenshot({ path: '/tmp/shot-panel.png' })
else console.log('面板未找到')
await browser.close()
