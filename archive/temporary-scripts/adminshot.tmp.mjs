import { chromium } from 'playwright-core'
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync('data/database.db', { readOnly: true })
const u = db.prepare("SELECT id FROM users WHERE username='xiaolin'").get()
const token = u ? db.prepare('SELECT token FROM login_tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(u.id)?.token : ''
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (token) await page.addInitScript(t => localStorage.setItem('space_token', t), token)
await page.goto('http://localhost:5172/admin?token=' + (token ?? ''), { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/shot-admin.png' })
console.log('[url]', page.url())
await browser.close()
