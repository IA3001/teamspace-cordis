// snap-page.mjs —— 用无头 chromium 给 5174 团队空间页截图（自测用，不进 gate）。
import { chromium } from 'playwright-core'
const url = process.argv[2] ?? 'http://127.0.0.1:5174/teamspace'
const out = process.argv[3] ?? '/tmp/page.png'
const browser = await chromium.launch()
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 900)
const page = await browser.newPage({ viewport: { width, height } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)) })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch((e) => console.log('goto:', e.message))
await page.waitForTimeout(2500)
await page.screenshot({ path: out, fullPage: process.argv[6] === 'full' })
console.log('saved', out)
await browser.close()
