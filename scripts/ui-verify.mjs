// ui-verify.mjs —— 团队空间页回归自测 + 三条会红断言（自用，不进 gate）。
// 断言区（AS1~AS3）任何一条不满足 → 输出 RED，进程退出码 1。
import { chromium } from '/home/ia3000/SPM/teamspace/.tmp/shots-run/node_modules/playwright-core/index.mjs'
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e).slice(0, 150)))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 150)) })
await page.goto('http://127.0.0.1:5174/teamspace', { waitUntil: 'networkidle', timeout: 20000 })
await page.waitForTimeout(2500)
const ta = page.locator('textarea')
const reds = []
const judge = (name, ok, detail) => { console.log(`[AS] ${name}: ${ok ? 'GREEN' : 'RED'} —— ${detail}`); if (!ok) reds.push(name) }

console.log('== 常规回归（暂存 × / 菜单 / 抽屉 / k-card）==')
await ta.fill('回归暂存条目'); await ta.press('Enter'); await page.waitForTimeout(1200)
const row = page.locator('span:has(> .el-tag:has-text("回归暂存条目"))').first()
console.log('暂存条目 + × 按钮:', await row.count(), await row.locator('button[aria-label*="删除暂存条目"]').count())
await row.locator('button[aria-label*="删除暂存条目"]').first().click(); await page.waitForTimeout(1200)
console.log('× 删除后残留:', await page.locator('.el-tag:has-text("回归暂存条目")').count())
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

// AS2 时间戳：真实鼠标移到消息几何中心（与测试代理同法 + elementFromPoint 校验命中），
// 驻留跨一次 4s 轮询 → 消息 li 内出现「作者 · HH:MM:SS」；移开 → 消失；默认 → 隐藏。
{
  let ok = true; const detail = []
  try {
    const liTextAt = async (sel) => {
      await page.locator(sel).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      const b = await page.locator(sel).first().boundingBox()
      if (!b) return { hit: 'no-box', text: '' }
      const x = b.x + b.width / 2, y = b.y + b.height / 2
      const hit = await page.evaluate(([px, py]) => {
        const e = document.elementFromPoint(px, py)
        return e ? (e.tagName + '.' + String(e.className).slice(0, 40)) : 'null'
      }, [x, y])
      await page.mouse.move(x, y)
      const text = await page.evaluate(([px, py]) => {
        const e = document.elementFromPoint(px, py)
        const li = e && e.closest('.el-timeline-item')
        return li ? li.innerText : ''
      }, [x, y])
      return { hit, text }
    }
    const sel = '.main-content .el-timeline-item__content'
    await page.locator(sel).first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    const before = await page.evaluate(() => {
      const li = document.querySelector('.main-content .el-timeline-item')
      return li ? li.innerText : ''
    })
    const hidden = !(/\d{2}:\d{2}:\d{2}/.test(before) && before.includes('·'))
    detail.push(`默认隐藏=${hidden}`)
    ok &&= hidden
    const h1 = await liTextAt(sel)
    detail.push(`命中=${h1.hit.slice(0, 36)}`)
    ok &&= h1.hit !== 'null' && h1.hit !== 'no-box'
    await page.waitForTimeout(4500) // 驻留跨一次 4s 轮询（重渲染后状态必须存活）
    const during = await liTextAt(sel)
    const revealed = /\d{2}:\d{2}:\d{2}/.test(during.text) && during.text.includes('·')
    detail.push(`真实悬停揭示(含作者·时间)=${revealed}`)
    ok &&= revealed
    await page.mouse.move(5, 400)
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => {
      const li = document.querySelector('.main-content .el-timeline-item')
      return li ? li.innerText : ''
    })
    const gone = !(/\d{2}:\d{2}:\d{2}/.test(after) && after.includes('·'))
    detail.push(`移开消失=${gone}`)
    ok &&= gone
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 80)) }
  judge('AS2 时间戳悬停揭示(真实鼠标/跨轮询存活/移开消失)', ok, detail.join(' | '))
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
    const run = async (name, fn) => { const s0 = Date.now(); await fn(); steps.push([name, Date.now() - s0]) }
    await run('1toggle展开', () => toggle.click())
    await run('2toggle折叠', () => toggle.click())
    await run('3textarea填充', () => ta2.fill('延迟探针'))
    await run('4读值', () => ta2.inputValue())
    await run('5抽屉开', async () => { await page.locator('.layout-header button:has-text("协作面板")').click(); await page.waitForTimeout(80) })
    await run('6抽屉关', async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(80) })
    await run('7toggle展开', () => toggle.click())
    await run('8toggle折叠', () => toggle.click())
    await run('9toggle展开', () => toggle.click())
    await run('10悬停消息', () => page.locator('.main-content .el-timeline-item__content').first().hover())
    const maxMs = Math.max(...steps.map((x) => x[1]))
    detail.push(`10步耗时=${JSON.stringify(steps.map((x) => x[1]))}ms max=${maxMs}ms`)
    ok &&= maxMs < 1000
    await toggle.click(); await page.waitForTimeout(150) // 恢复展开态
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 80)) }
  judge('AS3 折叠即时可靠+折叠态10步交互<1s', ok, detail.join(' | '))
}

console.log('页面错误:', errs.length ? errs : '（无）')
await page.screenshot({ path: '/tmp/ui-final.png' })
await browser.close()
console.log(`断言汇总: ${reds.length ? 'RED → ' + reds.join(', ') : '全部 GREEN'}`)
process.exitCode = reds.length ? 1 : 0
