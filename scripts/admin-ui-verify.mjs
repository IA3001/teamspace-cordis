import { bindSurface } from './dev/browser-surface.mjs'
// admin-ui-verify.mjs —— 免登录后台可达性与操作反馈回归。
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
bindSurface(page, new URL(baseURL).origin, process.cwd())
await page.addInitScript(() => {
  localStorage.removeItem('admin_token')
  const NativeWebSocket = window.WebSocket
  const failKey = 'uiVerifyFailAdminBootstrap'
  const injectedKey = 'uiVerifyAdminBootstrapInjected'
  const delayKey = 'uiVerifyDelayAdminSearchTest'
  const createFailureKey = 'uiVerifyFailCreateUser'
  const pwFailureKey = 'uiVerifyFailPasswordReset'
  const registrationFailureKey = 'uiVerifyFailRegistrationToggle'
  const approvalSeedKey = 'uiVerifySeedSandboxApproval'
  const approvalFailureKey = 'uiVerifyFailSandboxApproval'
  if (location.pathname === '/admin' && !sessionStorage.getItem(injectedKey)) {
    sessionStorage.setItem(injectedKey, '1')
    sessionStorage.setItem(failKey, '1')
  }
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args)
      let failedSn = null
      this.addEventListener('message', (event) => {
        if (failedSn === null) return
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame?.type !== 'rpc:response' || frame.body?.sn !== failedSn) return
        const sn = failedSn
        failedSn = null
        event.stopImmediatePropagation()
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
        })), 1200)
      }, { capture: true })
      const send = this.send.bind(this)
      this.send = (data) => {
        let request
        try { request = JSON.parse(String(data)) } catch { /* Non-RPC frames pass through. */ }
        if (sessionStorage.getItem('uiVerifyModelCatalogs') === '1' && ['getApiConfig', 'fetchTextModels', 'getEmbeddingIndexStatus', 'retryEmbeddingIndex'].includes(request?.body?.method)) {
          const { sn, method, args } = request.body
          const shape = { baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', hasKey: true, keyTail: 'test' }
          const profiles = (kind) => ['a', 'b'].map((suffix) => ({ ...shape, id: `${kind}-${suffix}`, name: `${kind.toUpperCase()} ${suffix}`, maxOutputTokens: null }))
          const scope = args?.[1]?.profileId || args?.[1]?.target
          if (method === 'retryEmbeddingIndex') sessionStorage.setItem('uiVerifyIndexState', 'ready')
          const indexState = sessionStorage.getItem('uiVerifyIndexState') || 'running'
          const value = method === 'getEmbeddingIndexStatus' ? {
            state: indexState, model: 'fixture-model', total: 50, completed: indexState === 'ready' ? 50 : 16,
            failed: indexState === 'failed' ? 34 : 0, error: indexState === 'failed' ? '模拟索引失败，可重试剩余任务。' : '', updatedAt: new Date().toISOString(),
          } : method === 'retryEmbeddingIndex' ? { ok: true } : method === 'getApiConfig' ? {
            text: { ...shape, timeoutMs: 60000 }, textProfiles: profiles('text'), activeTextProfileRef: '',
            embedding: shape, embeddingProfiles: profiles('embed'), activeEmbeddingProfileRef: '',
            webSearch: { ...shape, model: '' }, webSearchProfiles: profiles('search'), activeWebSearchProfileRef: '',
            status: { text: true, embedding: true },
          } : { ok: true, models: Array.from({ length: 50 }, (_, index) => `ui-${scope}-${String(index).padStart(2, '0')}`) }
          const delay = method === 'fetchTextModels' && sessionStorage.getItem('uiVerifySlowModelCatalog') === '1' ? 1200 : 200
          if (method === 'fetchTextModels') sessionStorage.removeItem('uiVerifySlowModelCatalog')
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: true, value } }),
          })), delay)
          return
        }
        if (request?.body?.method === 'sandboxApprovals' && sessionStorage.getItem(approvalSeedKey) === '1') {
          sessionStorage.removeItem(approvalSeedKey)
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: true, value: [{
              id: 'ui-approval-test', agentId: 'agent.coder', sessionId: 's_seed_demo',
              sourcePath: '/tmp/ui-approval.txt', reason: '验收拒绝原因和慢请求状态', status: 'pending',
              createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, decisionNote: '', deliveryPath: null,
            }] } }),
          })), 0)
          return
        }
        if (sessionStorage.getItem(approvalFailureKey) === '1' && request?.body?.method === 'decideSandboxApproval') {
          sessionStorage.removeItem(approvalFailureKey)
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
          })), 1200)
          return
        }
        if (sessionStorage.getItem(createFailureKey) === '1' && request?.body?.method === 'createUser') {
          sessionStorage.removeItem(createFailureKey)
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
          })), 1200)
          return
        }
        if (sessionStorage.getItem(pwFailureKey) === '1' && request?.body?.method === 'resetPassword') {
          sessionStorage.removeItem(pwFailureKey)
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
          })), 1200)
          return
        }
        if (sessionStorage.getItem(registrationFailureKey) === '1' && request?.body?.method === 'setRegisterEnabled') {
          sessionStorage.removeItem(registrationFailureKey)
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
          })), 1200)
          return
        }
        if (sessionStorage.getItem(delayKey) === '1' && request?.body?.method === 'testWebSearchApi') {
          sessionStorage.removeItem(delayKey)
          const sn = request.body.sn
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: {
              sn, ok: true, value: { ok: true, detail: 'UI 验收延迟响应' },
            } }),
          })), 1200)
          return
        }
        if (sessionStorage.getItem(failKey) === '1' && request?.body?.method === 'users') {
          sessionStorage.removeItem(failKey)
          failedSn = request.body.sn
        }
        return send(data)
      }
    }
  }
})
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 20000 })
  await page.locator('.sp-page-head').waitFor({ timeout: 10000 })
  assert.equal(await page.locator('.sp-login-gate').count(), 0, '后台无登录页，不会遮挡全局导航')
  assert.equal(await page.getByRole('button', { name: '登录后台', exact: true }).count(), 0, '后台免登录直达管理页面')

  const adminLoadError = page.getByText(/加载后台管理数据失败/)
  await adminLoadError.waitFor({ timeout: 10000 })
  const retryButton = page.getByRole('button', { name: '重试加载', exact: true })
  assert.ok(await retryButton.isVisible(), '后台核心数据加载失败时必须提供重试入口')
  assert.ok(!(await page.getByText('正在检查后台登录状态…', { exact: true }).count()),
    '免登录后台不应显示身份检查占位状态')
  assert.equal(await page.locator('.sp-admin-wrap .el-table').count(), 0,
    '首屏加载失败时不应把尚未读取的数据渲染成一组空表格')
  console.log('✓ Admin bootstrap shows loading, then a retryable failure without misleading empty tables')
  await page.screenshot({ path: '/tmp/admin-load-failure.png' })
  await retryButton.click()
  await adminLoadError.waitFor({ state: 'hidden', timeout: 10000 })
  await page.evaluate(() => sessionStorage.removeItem('uiVerifyFailAdminBootstrap'))
  for (const path of ['/admin', '/admin/runtime', '/admin/models']) {
    const navEntry = page.locator(`a[href="${path}"]`)
    assert.equal(await navEntry.count(), 1, `后台侧栏应提供独立导航入口 ${path}`)
    assert.equal(await navEntry.locator('svg[viewBox="0 0 24 24"]').count(), 1,
      `后台侧栏 ${path} 必须显示项目统一线性 SVG 图标`)
  }

  assert.equal(await page.locator('.sp-admin-tabs').count(), 0,
    '后台功能应拆成独立路由页面，而不是塞在单页标签中')
  assert.ok(await page.locator('.sp-page-head').getByRole('heading', { name: 'Team 账号', exact: true }).isVisible(), '默认页应直接展示 Team 账号管理')
  assert.equal(await page.getByText('AI 成员', { exact: true }).count(), 0,
    'Agent 配置统一由 Teamspace 管理，后台不应额外展示只读 AI 成员名单')
  assert.ok(!(await page.getByText('插件状态', { exact: true }).isVisible()),
    '插件状态不应挤在账号首屏下方')

  const registrationSwitch = page.locator('.sp-toolbar-group .el-switch')
  const registrationInput = registrationSwitch.locator('input[role="switch"]')
  const registrationLabel = page.locator('.sp-toolbar-group .sp-toolbar-label')
  const registrationBefore = await registrationLabel.innerText()
  await page.evaluate(() => sessionStorage.setItem('uiVerifyFailRegistrationToggle', '1'))
  await registrationSwitch.click()
  await page.getByText('正在更新注册设置…', { exact: true }).waitFor({ timeout: 1000 })
  assert.ok(await registrationInput.isDisabled(), '注册设置保存期间应禁用开关')
  await page.getByText(/修改注册设置失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
  assert.equal(await registrationLabel.innerText(), registrationBefore, '注册设置保存失败后应恢复原状态')
  assert.ok(await registrationInput.isEnabled(), '注册设置失败后开关应恢复可用')
  console.log('✓ Registration setting shows pending state, blocks duplicate changes, and rolls back on failure')

  await page.evaluate(() => sessionStorage.setItem('uiVerifySeedSandboxApproval', '1'))
  await page.goto(new URL('/admin/runtime', baseURL).href, { waitUntil: 'networkidle' })
  await page.locator('.sp-page-head').waitFor({ timeout: 10000 })
  assert.ok(await page.locator('.sp-page-head').getByRole('heading', { name: '运行状态与审批', exact: true }).isVisible(),
    '运行状态和审批应有独立页面')
  const approvalTable = page.locator('.sp-admin-wrap .el-table').filter({ hasText: '/tmp/ui-approval.txt' })
  await approvalTable.waitFor({ state: 'visible', timeout: 5000 })
  await approvalTable.getByRole('button', { name: '拒绝', exact: true }).click()
  const approvalDialog = page.locator('.el-dialog:visible').filter({ hasText: '拒绝越界请求' })
  await approvalDialog.waitFor({ state: 'visible', timeout: 5000 })
  assert.ok(await approvalDialog.getByText('/tmp/ui-approval.txt', { exact: true }).isVisible(), '审批确认应显示确切申请路径')
  assert.ok(await approvalDialog.getByText('验收拒绝原因和慢请求状态', { exact: true }).isVisible(), '审批确认应显示申请理由')
  const approvalNote = approvalDialog.locator('textarea')
  await approvalNote.fill('超出当前任务范围')
  await page.evaluate(() => sessionStorage.setItem('uiVerifyFailSandboxApproval', '1'))
  await approvalDialog.getByRole('button', { name: '确认拒绝', exact: true }).click()
  await approvalDialog.getByRole('button', { name: '正在提交…', exact: true }).waitFor({ timeout: 1000 })
  assert.ok(await approvalNote.isDisabled(), '审批请求等待时应锁定拒绝原因')
  assert.ok(await approvalDialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), '审批请求等待时应禁止关闭确认弹窗')
  await approvalDialog.getByText(/拒绝沙箱请求失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
  assert.equal(await approvalNote.inputValue(), '超出当前任务范围', '审批请求失败后应保留拒绝原因以便重试')
  assert.ok(await approvalDialog.getByRole('button', { name: '确认拒绝', exact: true }).isEnabled(), '失败后审批操作应恢复可用')
  await approvalDialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.goto(new URL('/admin', baseURL).href, { waitUntil: 'networkidle' })
  console.log('✓ Sandbox approval uses an in-app confirmation, explains file-copy boundaries, and preserves retry state')

  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  const createDialog = page.locator('.el-dialog:visible').filter({ hasText: '创建 Team 账号' })
  await createDialog.waitFor({ state: 'visible', timeout: 5000 })
  const createFields = createDialog.locator('.el-form-item input')
  await createFields.nth(0).fill('ui_verify_create_failure')
  await createFields.nth(1).fill('验收保留输入')
  await createFields.nth(2).fill('UiVerify-pass-1')
  await page.evaluate(() => sessionStorage.setItem('uiVerifyFailCreateUser', '1'))
  await createDialog.getByRole('button', { name: '创建', exact: true }).click()
  await createDialog.getByRole('button', { name: '正在创建…', exact: true }).waitFor({ timeout: 1000 })
  const inputsLocked = await createFields.evaluateAll((inputs) => inputs.length === 3 && inputs.every((input) => input.disabled))
  assert.ok(inputsLocked, '账号创建等待时应锁定输入，避免提交内容与表单内容不一致')
  assert.ok(await createDialog.getByRole('button', { name: '取消', exact: true }).isDisabled(),
    '账号创建期间应避免关闭弹窗导致结果反馈丢失')
  await createDialog.getByText(/创建 Team 账号失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
  assert.equal(await createFields.nth(0).inputValue(), 'ui_verify_create_failure', '失败后用户名应保留以便修改重试')
  assert.equal(await createFields.nth(1).inputValue(), '验收保留输入', '失败后显示名应保留以便修改重试')
  assert.equal(await createFields.nth(2).inputValue(), 'UiVerify-pass-1', '失败后密码应保留以便重试')
  assert.ok(await createDialog.getByRole('button', { name: '创建', exact: true }).isEnabled(),
    '请求失败后创建操作应恢复可用')
  await createDialog.getByRole('button', { name: '取消', exact: true }).click()
  console.log('✓ Team account creation keeps failures inside the dialog, locks pending inputs, and preserves retry values')

  await page.locator('.sp-admin-wrap .el-table').first().getByRole('button', { name: '修改密码', exact: true }).first().click()
  const passwordDialog = page.locator('.el-dialog:visible').filter({ hasText: '修改密码' })
  await passwordDialog.waitFor({ state: 'visible', timeout: 5000 })
  const passwordInput = passwordDialog.locator('input[type="password"]')
  await passwordInput.fill('UiVerify-reset-pass-2')
  await page.evaluate(() => sessionStorage.setItem('uiVerifyFailPasswordReset', '1'))
  await passwordDialog.getByRole('button', { name: '确定', exact: true }).click()
  await passwordDialog.getByRole('button', { name: '正在保存…', exact: true }).waitFor({ timeout: 1000 })
  assert.ok(await passwordInput.isDisabled(), '密码重置等待时应锁定输入')
  assert.ok(await passwordDialog.getByRole('button', { name: '取消', exact: true }).isDisabled(),
    '密码重置期间应避免关闭弹窗导致结果反馈丢失')
  await passwordDialog.getByText(/修改账号密码失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
  assert.equal(await passwordInput.inputValue(), 'UiVerify-reset-pass-2', '重置失败后应保留密码以便修改或重试')
  assert.ok(await passwordDialog.getByRole('button', { name: '确定', exact: true }).isEnabled(),
    '密码重置失败后操作应恢复可用')
  await passwordDialog.getByRole('button', { name: '取消', exact: true }).click()
  console.log('✓ Password reset keeps retry errors in the dialog and locks pending input')

  const pageActions = page.locator('.sp-page-actions')
  assert.equal(await pageActions.getByText('登出', { exact: true }).count(), 0, '免登录后台不显示登出入口')

  await page.evaluate(() => sessionStorage.setItem('uiVerifyModelCatalogs', '1'))
  await page.goto(new URL('/admin/models', baseURL).href, { waitUntil: 'networkidle' })
  await page.locator('.sp-page-head').waitFor({ timeout: 10000 })
  assert.ok(await page.locator('.sp-page-head').getByRole('heading', { name: '模型与服务', exact: true }).isVisible(),
    '模型供应商和服务配置应有独立页面')
  assert.equal(await page.locator('.sp-admin-model-tabs').count(), 0,
    '模型供应商管理不应再拆成 API 接入和文字模型供应商两个重复入口')
  const modelSection = page.locator('.sp-admin-wrap .sp-section').filter({ hasText: 'AI 服务供应商' }).first()
  await modelSection.scrollIntoViewIfNeeded()
  for (const label of ['对话模型', '嵌入模型', '网页搜索']) {
    assert.ok(await modelSection.getByRole('tab', { name: label, exact: true }).isVisible(), `模型供应商页应提供${label}用途页签`)
  }
  assert.ok(await modelSection.locator('.sp-admin-model-provider-list').isVisible(), '对话供应商应使用可选列表')
  assert.ok(await modelSection.locator('.sp-admin-model-provider-editor').isVisible(), '选中供应商后应在右侧编辑')
  console.log('✓ Model providers are grouped by capability and use a selectable list with a detail editor')

  await page.setViewportSize({ width: 1440, height: 900 })
  const providerEditor = page.locator('.sp-admin-wrap .sp-section').filter({ hasText: 'AI 服务供应商' })
  const providerRows = providerEditor.locator('.sp-admin-model-provider-item')
  assert.ok(await providerRows.count() >= 2, '对话供应商列表应包含默认项和已保存供应商')
  await providerRows.nth(1).click()
  await providerEditor.getByText(/编辑供应商/u).waitFor({ timeout: 3000 })
  const providerIdBox = await providerEditor.locator('input[placeholder="qwen-prod"]').boundingBox()
  const providerNameBox = await providerEditor.locator('input[placeholder="阿里云 Qwen"]').boundingBox()
  const providerBaseBox = await providerEditor.locator('textarea[placeholder="https://provider.example/v1"]').last().boundingBox()
  assert.ok(providerIdBox && providerNameBox && providerBaseBox &&
    providerIdBox.x < providerNameBox.x && Math.abs(providerIdBox.y - providerNameBox.y) < 8 &&
    providerBaseBox.width > providerIdBox.width * 1.6,
  '桌面端供应商表单应将关联短字段并排，长 Base URL 保持整行')
  console.log('✓ Desktop model-provider form groups short fields in columns and gives Base URL a full row')
  const catalog = providerEditor.locator('.el-table[aria-label="可选择的模型列表"]')
  const fetchModels = providerEditor.getByRole('button', { name: '获取模型列表', exact: true })
  await providerRows.first().click()
  await fetchModels.click()
  await catalog.getByText('ui-text-00', { exact: true }).waitFor()
  await providerRows.nth(1).click()
  assert.equal(await catalog.count(), 0, 'a custom provider never inherits the default provider\'s catalog')
  await fetchModels.click()
  await catalog.getByText('ui-text-a-00', { exact: true }).waitFor()
  const scroller = catalog.locator('.el-scrollbar__wrap')
  assert.ok(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight), 'long model catalogs scroll inside their bounded window')
  await catalog.getByText('ui-text-a-37', { exact: true }).click()
  assert.equal(await providerEditor.locator('input[placeholder="手动输入或从下方列表选择模型"]').inputValue(), 'ui-text-a-37')
  await providerEditor.getByPlaceholder('搜索模型名称或 ID').fill('37')
  await providerRows.nth(2).click()
  assert.equal(await catalog.count(), 0, 'a second provider with the same Base URL must not show the first provider\'s cached list')
  await fetchModels.click()
  await catalog.getByText('ui-text-b-00', { exact: true }).waitFor()
  await providerRows.nth(1).click()
  assert.equal(await providerEditor.getByPlaceholder('搜索模型名称或 ID').inputValue(), '37', 'each provider retains its own search query')
  assert.equal(await catalog.getByText('ui-text-b-00', { exact: true }).count(), 0, 'switching back restores only the originating provider\'s list')
  await providerEditor.locator('input[type="password"]').fill('fixture-new-key')
  assert.equal(await catalog.count(), 0, 'editing credentials invalidates only the current provider\'s old model catalog')
  await page.evaluate(() => sessionStorage.setItem('uiVerifySlowModelCatalog', '1'))
  await fetchModels.click()
  await providerEditor.getByRole('tab', { name: '嵌入模型', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.sp-admin-model-provider-editor button')]
    .some((button) => button.textContent?.includes('获取模型列表') && !button.disabled))
  assert.equal(await catalog.count(), 0, 'text model results never leak into the default Embedding provider')
  await providerEditor.getByText('正在重建向量索引', { exact: true }).waitFor()
  assert.ok(await providerEditor.getByText(/已完成 16 \/ 50 个分块/u).isVisible(), 'the background rebuild exposes exact progress')
  await page.evaluate(() => sessionStorage.setItem('uiVerifyIndexState', 'failed'))
  await providerEditor.getByRole('button', { name: '重试未完成索引', exact: true }).waitFor()
  await providerEditor.getByRole('button', { name: '重试未完成索引', exact: true }).click()
  await providerEditor.getByText('向量索引已就绪', { exact: true }).waitFor()
  await providerEditor.getByRole('tab', { name: '对话模型', exact: true }).click()
  await providerRows.nth(1).click()
  await catalog.getByText('ui-text-a-00', { exact: true }).waitFor()
  assert.equal(await catalog.getByText('ui-text-b-00', { exact: true }).count(), 0, 'a delayed response remains attached to the provider that initiated it')
  await providerEditor.getByRole('tab', { name: '嵌入模型', exact: true }).click()
  const embedRows = providerEditor.locator('.sp-admin-model-provider-item')
  await embedRows.nth(1).click()
  await fetchModels.click()
  await catalog.getByText('ui-embed-a-00', { exact: true }).waitFor()
  await embedRows.nth(2).click()
  assert.equal(await catalog.count(), 0, 'Embedding provider catalogs are isolated by provider ID')
  await fetchModels.click()
  await catalog.getByText('ui-embed-b-00', { exact: true }).waitFor()
  await embedRows.nth(1).click()
  await catalog.getByText('ui-embed-a-00', { exact: true }).waitFor()
  await providerEditor.getByRole('button', { name: '新增嵌入模型供应商', exact: true }).click()
  assert.ok(await providerEditor.getByText('Embedding 模型 ID', { exact: true }).isVisible(), 'new Embedding providers expose the model selection form')
  assert.equal(await catalog.count(), 0, 'an unsaved provider starts with its own empty catalog')
  await providerEditor.getByRole('tab', { name: '网页搜索', exact: true }).click()
  await providerEditor.getByRole('button', { name: '新增网页搜索供应商', exact: true }).click()
  assert.ok(await providerEditor.getByRole('button', { name: '保存配置', exact: true }).isVisible(), 'web-search providers can be added with the same list/editor interaction')
  await providerEditor.locator('.sp-admin-model-provider-item').first().click()
  console.log('✓ Model catalogs, search queries, and selected values are isolated across text and Embedding providers; Embedding and search providers expose creation forms')
  await page.locator('.sp-page-head').scrollIntoViewIfNeeded()

  // Slow model/provider checks keep one clear operation active and disable
  // competing configuration actions until the response has arrived.
  const apiSectionDesktop = page.locator('.sp-admin-wrap .sp-section').filter({ hasText: 'AI 服务供应商' }).first()
  await apiSectionDesktop.scrollIntoViewIfNeeded()
  await apiSectionDesktop.getByRole('tab', { name: '网页搜索', exact: true }).click()
  const webSearchCard = apiSectionDesktop.getByText('网页搜索供应商', { exact: true }).locator('xpath=..')
  const webSearchTest = webSearchCard.getByRole('button', { name: '连通测试' })
  await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayAdminSearchTest', '1'))
  await webSearchTest.click()
  await page.waitForTimeout(150)
  assert.ok(await webSearchTest.evaluate((button) => button.classList.contains('is-loading')),
    '慢速网页搜索连接检查应显示进行中状态')
  assert.ok(await webSearchCard.getByRole('button', { name: '保存' }).isDisabled(),
    '连接检查期间应禁止保存同组配置')
  assert.ok(await webSearchCard.locator('input').first().isDisabled(),
    '连接检查期间应锁定配置输入，避免结果与页面编辑值不一致')
  await page.getByText('UI 验收延迟响应', { exact: true }).waitFor({ timeout: 5000 })
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll('strong')].find((item) => item.textContent === '网页搜索供应商')
    const button = heading?.parentElement?.querySelector('button')
    return button && !button.classList.contains('is-loading') && !button.disabled
  }, { timeout: 5000 })
  const localTestFeedback = webSearchCard.locator('.el-alert')
  await localTestFeedback.waitFor({ timeout: 3000 })
  assert.ok((await localTestFeedback.innerText()).includes('UI 验收延迟响应'),
    'slow provider-test results should appear beside the provider controls, not only at the page top')
  console.log('✓ Slow Admin provider checks show progress, lock conflicting edits, and release controls after response')

  await page.evaluate(() => localStorage.setItem('space_token', 'unrelated-team-session'))
  const storage = await page.evaluate(() => ({
    adminToken: localStorage.getItem('admin_token'),
    teamToken: localStorage.getItem('space_token'),
  }))
  assert.equal(storage.adminToken, null, '后台管理页不创建后台 token')
  assert.equal(storage.teamToken, 'unrelated-team-session', '后台管理页不读取或改写 Team token')
  assert.deepEqual(pageErrors, [], '后台页不应产生浏览器异常')
  console.log('✓ Admin UI opens without login, preserves global navigation, and does not touch Team sessions')
} finally {
  await page.evaluate(() => {
    sessionStorage.removeItem('uiVerifyFailAdminBootstrap')
    sessionStorage.removeItem('uiVerifyModelCatalogs')
    sessionStorage.removeItem('uiVerifySlowModelCatalog')
    sessionStorage.removeItem('uiVerifyIndexState')
    sessionStorage.removeItem('uiVerifyDelayAdminSearchTest')
    sessionStorage.removeItem('uiVerifyFailCreateUser')
    sessionStorage.removeItem('uiVerifyFailPasswordReset')
    sessionStorage.removeItem('uiVerifyFailRegistrationToggle')
    sessionStorage.removeItem('uiVerifySeedSandboxApproval')
    sessionStorage.removeItem('uiVerifyFailSandboxApproval')
  }).catch(() => {})
  await browser.close()
}
