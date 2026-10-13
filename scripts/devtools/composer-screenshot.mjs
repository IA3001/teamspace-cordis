import { chromium } from 'playwright-core'
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync('data/database.db', { readOnly: true })
const token = db.prepare('SELECT token FROM login_tokens ORDER BY created_at DESC LIMIT 1').get().token
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
await page.addInitScript(t => localStorage.setItem('space_token', t), token)
await page.goto('http://localhost:5174/teamspace', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(3000)
const card = page.locator('.sp-composer')
console.log('composer 存在:', (await card.count()) > 0 ? '✅' : '❌')
if ((await card.count()) > 0) await card.screenshot({ path: '/tmp/shot-composer.png' })
await page.screenshot({ path: '/tmp/shot-composer-full.png' })
await browser.close()
