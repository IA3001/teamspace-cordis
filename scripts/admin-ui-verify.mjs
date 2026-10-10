// admin-ui-verify.mjs —— 独立后台登录、页级登出入口及会话清理回归。
// 只用于 gate:runtime 的隔离开发环境；不修改 Team 账号或业务数据。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const envPath = new URL('../.env', import.meta.url)
const envSource = readFileSync(existsSync(envPath) ? envPath : new URL('../.env.example', import.meta.url), 'utf8')
function setting(name, fallback) {
  const raw = process.env[name] ?? envSource.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]
  if (!raw) return fallback
  return raw.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)
}

const port = setting('DEBUG_PORT', '')
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('DEBUG_PORT 缺失或无效；请配置后台调试控制台端口')
}
const baseURL = `http://127.0.0.1:${port}/admin`
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
  : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 20000 })
  const username = setting('ADMIN_USERNAME', 'admin')
  const password = setting('ADMIN_PASSWORD', '123456')
  if (!(await page.locator('.sp-page-head').count())) {
    await page.locator('.sp-login-gate input[placeholder="管理员用户名"]').fill(username)
    await page.locator('.sp-login-gate input[type="password"]').fill(password)
    await page.locator('.sp-login-gate button.el-button').click()
    await page.locator('.sp-page-head').waitFor({ timeout: 10000 })
  }

  const pageActions = page.locator('.sp-page-actions')
  const logout = pageActions.locator('el-button')
  assert.equal(await pageActions.innerText(), '登出', '登出应位于页级操作区')
  assert.equal(await logout.count(), 1, '页头应有且仅有一个登出操作')
  assert.equal(await page.locator('.sp-toolbar').getByText('登出', { exact: true }).count(), 0,
    '登出不应混入用户表格工具栏')

  await page.evaluate(() => localStorage.setItem('space_token', 'unrelated-team-session'))
  await logout.click()
  await page.locator('.sp-login-gate').waitFor({ timeout: 10000 })
  const storage = await page.evaluate(() => ({
    adminToken: localStorage.getItem('admin_token'),
    teamToken: localStorage.getItem('space_token'),
  }))
  assert.equal(storage.adminToken, null, '后台登出应清除后台 token')
  assert.equal(storage.teamToken, 'unrelated-team-session', '后台登出不得清理 Team token')
  assert.deepEqual(pageErrors, [], '后台页不应产生浏览器异常')
  console.log('✓ Admin UI page action is correctly placed; logout clears only the Admin session')
} finally {
  await browser.close()
}
