import { bindSurface } from './dev/browser-surface.mjs'
// ui-verify.mjs —— 团队空间页回归自测 + 会红断言（gate:runtime 最后一项）。
// 断言区（AS1~AS15）任何一条不满足 → 输出 RED，进程退出码 1。
// Playwright 使用标准浏览器缓存；自定义浏览器路径通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定。
import { chromium } from 'playwright-core'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
const envPath = new URL('../.env', import.meta.url)
const envSource = readFileSync(existsSync(envPath) ? envPath : new URL('../.env.example', import.meta.url), 'utf8')
const nodeEnv = process.env.NODE_ENV ?? envSource.match(/^NODE_ENV=(.*)\s*$/m)?.[1]?.trim()
if (nodeEnv === 'production') {
  throw new Error('拒绝在 production 环境运行 UI 验收：测试会创建模板并临时加入 seed 会话')
}
const teamspacePort = process.env.TEAMSPACE_PORT ?? envSource.match(/^TEAMSPACE_PORT=(\d+)\s*$/m)?.[1]
if (!teamspacePort || Number(teamspacePort) < 1 || Number(teamspacePort) > 65535) {
  throw new Error('TEAMSPACE_PORT 缺失或无效；请在 .env 中配置唯一监听端口')
}
const teamspaceBase = `http://127.0.0.1:${teamspacePort}`
let temporaryDemoMember = null
let temporaryDecisionSession = null
let temporaryRenameSession = null
function cleanTemporaryDemoMember() {
  if (!temporaryDemoMember) return true
  const { sessionId, userId } = temporaryDemoMember
  const db = new DatabaseSync('data/database.db')
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.prepare(`UPDATE session_members SET status='left', left_at=?
      WHERE session_id=? AND principal_id=? AND status='active'`).run(new Date().toISOString(), sessionId, userId)
    const row = db.prepare('SELECT status FROM session_members WHERE session_id=? AND principal_id=?')
      .get(sessionId, userId)
    temporaryDemoMember = null
    return row?.status === 'left'
  } catch (error) {
    console.error(`[ui-verify] 无法清理 seed 会话验收成员：${String(error?.message ?? error)}`)
    return false
  } finally { db.close() }
}
function cleanTemporaryDecisionSession() {
  if (!temporaryDecisionSession) return true
  const sessionId = temporaryDecisionSession
  const db = new DatabaseSync('data/database.db')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const events = db.prepare('SELECT rowid, text FROM events WHERE session_id=?').all(sessionId)
    const removeSearchEntry = db.prepare("INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', ?, ?)")
    for (const event of events) removeSearchEntry.run(event.rowid, event.text)
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId)
    temporaryDecisionSession = null
    return !db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)
  } catch (error) {
    console.error(`[ui-verify] 无法清理临时 DRI 决策会话：${String(error?.message ?? error)}`)
    return false
  } finally { db.close() }
}
function cleanTemporaryRenameSession() {
  if (!temporaryRenameSession) return true
  const sessionId = temporaryRenameSession
  const db = new DatabaseSync('data/database.db')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId)
    temporaryRenameSession = null
    return !db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)
  } catch (error) {
    console.error(`[ui-verify] 无法清理临时重命名会话：${String(error?.message ?? error)}`)
    return false
  } finally { db.close() }
}
process.once('exit', cleanTemporaryDemoMember)
process.once('exit', cleanTemporaryDecisionSession)
process.once('exit', cleanTemporaryRenameSession)
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
  : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  const NativeWebSocket = window.WebSocket
  const sockets = []
  window.__uiVerifySockets = sockets
  window.__uiVerifyRpcMethods = []
  const failureMethods = {
    uiVerifyFailAgentBootstrap: 'agentDefinitions',
    uiVerifyFailKbBootstrap: 'docs',
    uiVerifyFailKbSearch: 'searchKb',
  }
  const delayedSuccessMethods = {
    uiVerifyDelaySessionInvite: { method: 'invite', value: { ok: true } },
    uiVerifyDelayKbAdd: {
      method: 'addDoc',
      value: { id: 'ui-verify-kb-add', title: '验收草稿标题', source: 'manual', size: 11, createdAt: new Date().toISOString(), chunkCount: 1 },
    },
    uiVerifySeedKbSearch: {
      method: 'searchKb',
      value: [{ docTitle: '旧查询结果', text: '这条旧结果只应在旧查询中显示。', source: 'manual', score: 1, docId: 'ui-stub', chunkId: 'ui-stub-chunk' }],
    },
    uiVerifyEmptyKbSearch: {
      method: 'searchKb',
      value: { error: 'empty_query', detail: '检索词不能为空' },
    },
  }
  const delayedResponseMethods = {
    uiVerifyDelayAgentInvite: 'inviteAgent',
    uiVerifyDelayMemberList: 'members',
    uiVerifyDelayKbSearch: 'searchKb',
  }
  const delayedFailureMethods = {
    uiVerifyDelayGroupCreateFailure: 'createGroup',
    uiVerifyDelayAgentSaveFailure: 'updateAgent',
    uiVerifyDelayRenameFailure: 'rename',
  }
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args)
      sockets.push(this)
      let failRpcSn = null
      let delayRpcSn = null
      this.addEventListener('message', (event) => {
        if (failRpcSn === null && delayRpcSn === null) return
        let response
        try { response = JSON.parse(String(event.data)) } catch { return }
        if (response?.type !== 'rpc:response') return
        if (delayRpcSn !== null && response.body?.sn === delayRpcSn) {
          const sn = delayRpcSn
          delayRpcSn = null
          event.stopImmediatePropagation()
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: String(event.data) })), 1200)
          return
        }
        if (response.body?.sn !== failRpcSn) return
        const sn = failRpcSn
        failRpcSn = null
        event.stopImmediatePropagation()
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
        })), 1200)
      }, { capture: true })
      const nativeSend = this.send.bind(this)
      this.send = (data) => {
        let request
        try { request = JSON.parse(String(data)) } catch { /* Non-RPC frames pass through. */ }
        if (request?.type === 'rpc:request' && typeof request.body?.method === 'string') {
          window.__uiVerifyRpcMethods.push(request.body.method)
        }
        if (request?.type === 'rpc:request' && request.body?.method === 'turn' && sessionStorage.getItem('uiVerifyUnknownPause') === '1') {
          const sn = request.body.sn
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: true, value: { state: 'static', decisionCalls: 0, delegatedTargets: [], stopReason: 'private_internal_reason', stopDetail: '' } } }),
          })), 10)
          return
        }
        const matchingFailure = Object.entries(failureMethods)
          .find(([key, method]) => sessionStorage.getItem(key) === '1' && request?.body?.method === method)
        const matchingDelayedSuccess = Object.entries(delayedSuccessMethods)
          .find(([key, spec]) => sessionStorage.getItem(key) === '1' && request?.body?.method === spec.method)
        if (matchingDelayedSuccess && Number.isInteger(request?.body?.sn)) {
          sessionStorage.removeItem(matchingDelayedSuccess[0])
          const { sn } = request.body
          const { value } = matchingDelayedSuccess[1]
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: true, value } }),
          })), 1200)
          return
        }
        const matchingDelay = Object.entries(delayedResponseMethods)
          .find(([key, method]) => sessionStorage.getItem(key) === '1' && request?.body?.method === method)
        const matchingDelayedFailure = Object.entries(delayedFailureMethods)
          .find(([key, method]) => sessionStorage.getItem(key) === '1' && request?.body?.method === method)
        if (matchingDelayedFailure && Number.isInteger(request?.body?.sn)) {
          sessionStorage.removeItem(matchingDelayedFailure[0])
          const { sn } = request.body
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'rpc:response', body: { sn, ok: false, message: 'UI verification simulated network timeout' } }),
          })), 1200)
          return
        }
        if (matchingDelay && Number.isInteger(request?.body?.sn)) {
          sessionStorage.removeItem(matchingDelay[0])
          delayRpcSn = request.body.sn
        }
        if (matchingFailure && Number.isInteger(request?.body?.sn)) {
          sessionStorage.removeItem(matchingFailure[0])
          failRpcSn = request.body.sn
        }
        if (this.readyState !== WebSocket.OPEN) return
        return nativeSend(data)
      }
    }
  }
})
bindSurface(page, teamspaceBase, process.cwd())
const errs = []
let expectedUploadFailureResponses = false
page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e).slice(0, 150) + `\n${e.stack ?? ''}`.slice(0, 600)))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const message = m.text()
  if (expectedUploadFailureResponses && /413 \(Payload Too Large\)|net::ERR_FAILED/.test(message)) return
  errs.push('[console] ' + message.slice(0, 150))
})
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
    temporaryDemoMember = { sessionId: session.id, userId: user.user_id }
    db.prepare(`INSERT INTO session_members(session_id, principal_id, role, status, joined_at, left_at, duty)
      VALUES (?, ?, '成员', 'active', ?, NULL, '')
      ON CONFLICT(session_id, principal_id) DO UPDATE SET status='active', left_at=NULL`).run(
      session.id, user.user_id, new Date().toISOString(),
    )
  } finally { db.close() }
  await page.goto(`${teamspaceBase}/teamspace`, { waitUntil: 'networkidle', timeout: 20000 })
}
if (!(await page.locator('textarea').count())) throw new Error(
  `登录后未进入 Teamspace 消息输入区；url=${page.url()}；body=${(await page.locator('body').innerText()).slice(0, 240)}；errors=${errs.join(' | ')}`,
)
await page.waitForTimeout(2500)
const ta = page.locator('textarea')
const reds = []
const judge = (name, ok, detail) => { console.log(`[AS] ${name}: ${ok ? 'GREEN' : 'RED'} —— ${detail}`); if (!ok) reds.push(name) }

// Reply status must be visible while the server is still waiting for Agent
// memory catch-up; the actual runtime start then takes over the pending bubble.
{
  let ok = true; const detail = []
  let syntheticClockInstalled = false
  try {
    const sessionId = new URL(page.url()).searchParams.get('session')
    const sourceEventId = `ui-pending-${randomUUID()}`
    const runId = `ui-run-${randomUUID()}`
    await page.evaluate(({ sessionId, sourceEventId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      if (!socket) throw new Error('未找到已连接的 Teamspace WebSocket')
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:session-work', body: { activeSessionId: null, owners: [], queue: [] },
      }) }))
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:reply-pending', body: { sessionId, sourceEventId, authorId: 'u_ui_verify', mentions: ['a_analyst'], at: new Date().toISOString() },
      }) }))
    }, { sessionId, sourceEventId })
    await page.locator('.sp-msg-pending').waitFor({ state: 'visible', timeout: 1500 })
    const pendingText = await page.locator('.sp-msg-pending').innerText()
    const pendingVisible = pendingText.includes('等待 Agent 顺序消化此前消息与记忆') && /已等待 \d+ 秒/u.test(pendingText)
    detail.push(`回复准备气泡显示前序记忆阶段且持续计时=${pendingVisible}`)
    ok &&= pendingVisible
    await page.evaluate((sessionId) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:session-work', body: {
          activeSessionId: 's_other_running', owners: ['agent-inbox'],
          queue: [{ sessionId, owner: 'agent-inbox', position: 2 }],
        },
      }) }))
    }, sessionId)
    await page.locator('.sp-msg-pending').filter({ hasText: '本会话排队第 2 位' }).waitFor({ timeout: 1500 })
    const queueVisible = (await page.locator('.sp-msg-pending').innerText()).includes('本会话排队第 2 位')
    detail.push(`全局 Agent 队列展示本会话位置=${queueVisible}`)
    ok &&= queueVisible
    await page.evaluate(({ sessionId, sourceEventId, runId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress', body: {
          runId, sessionId, agentId: 'a_analyst', title: '需求分析师', sourceEventId,
          phase: 'started', at: new Date().toISOString(),
        },
      }) }))
    }, { sessionId, sourceEventId, runId })
    await page.locator('.sp-msg-pending').waitFor({ state: 'detached', timeout: 1500 })
    const runtimeRow = page.locator('.sp-msg').filter({ hasText: '需求分析师 · 正在工作' }).last()
    const runtimeVisible = await runtimeRow.count() > 0
    detail.push(`Agent 开始运行后进度气泡接管=${runtimeVisible}`)
    ok &&= runtimeVisible
    const firstStage = await runtimeRow.locator('.sp-progress-card .el-collapse-item__header').innerText().catch(() => '')
    const stageVisible = firstStage.includes('开始处理任务') && firstStage.includes('本阶段') && firstStage.includes('本轮')
    detail.push(`折叠态显示当前阶段及阶段/整轮计时=${stageVisible}（${firstStage.trim()}）`)
    ok &&= stageVisible
    await page.evaluate(({ sessionId, sourceEventId, runId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress-snapshot', body: {
          runId, sessionId, agentId: 'a_analyst', title: '需求分析师', sourceEventId,
          phase: 'waiting-model', at: new Date().toISOString(),
          steps: [
            { label: '整理会话、记忆与知识库上下文', at: new Date().toISOString() },
            { label: '正在请求模型，等待首个响应', at: new Date().toISOString() },
          ],
          streamText: '', streamCharacterCount: 0, streamTruncated: false,
        },
      }) }))
    }, { sessionId, sourceEventId, runId })
    const waitingHeader = runtimeRow.locator('.sp-progress-card .el-collapse-item__header')
    await waitingHeader.filter({ hasText: '正在请求模型，等待首个响应' }).waitFor({ timeout: 1500 })
    await page.evaluate(() => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress-snapshot', body: {
          runId: 'ui-global-queue-run', sessionId: 's_other_running', agentId: 'agent.coder',
          title: '编码者', sourceEventId: 'ui-global-queue-source', phase: 'waiting-model',
          at: new Date().toISOString(), steps: [
            { label: '整理会话、记忆与知识库上下文', at: new Date().toISOString() },
            { label: '正在请求模型，等待首个响应', at: new Date().toISOString() },
          ], streamText: '', streamCharacterCount: 0, streamTruncated: false,
        },
      }) }))
    })
    const queueSection = page.getByRole('status', { name: 'Agent 处理队列' })
    await queueSection.getByText(/编码者.*正在请求模型，等待首个响应/u).waitFor({ timeout: 1500 })
    const queueSectionText = await queueSection.innerText()
    const queuedSessionSeesGlobalStage = queueSectionText.includes('本阶段') && queueSectionText.includes('最近进度')
    detail.push(`查看排队会话时，协作面板显示全局 Agent 当前阶段与计时=${queuedSessionSeesGlobalStage}`)
    ok &&= queuedSessionSeesGlobalStage
    await page.evaluate(({ sessionId, sourceEventId, runId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress', body: {
          runId, sessionId, agentId: 'a_analyst', title: '需求分析师', sourceEventId,
          phase: 'tool-start', toolId: 'tool.workspace.read', toolTitle: '读取工作区文件', at: new Date().toISOString(),
        },
      }) }))
    }, { sessionId, sourceEventId, runId })
    await waitingHeader.filter({ hasText: '调用工具：读取工作区文件' }).waitFor({ timeout: 1500 })
    const humanToolNameVisible = (await waitingHeader.innerText()).includes('调用工具：读取工作区文件')
    detail.push(`工具阶段显示用户可读名称=${humanToolNameVisible}`)
    ok &&= humanToolNameVisible
    await page.evaluate(({ sessionId, sourceEventId, runId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress-snapshot', body: {
          runId, sessionId, agentId: 'a_analyst', title: '需求分析师', sourceEventId,
          phase: 'waiting-model', at: new Date().toISOString(),
          steps: [
            { label: '整理会话、记忆与知识库上下文', at: new Date().toISOString() },
            { label: '正在请求模型，等待首个响应', at: new Date().toISOString() },
          ],
          streamText: '', streamCharacterCount: 0, streamTruncated: false,
        },
      }) }))
    }, { sessionId, sourceEventId, runId })
    await waitingHeader.filter({ hasText: '正在请求模型，等待首个响应' }).waitFor({ timeout: 1500 })
    await waitingHeader.click()
    const progressItem = runtimeRow.locator('.sp-progress-item')
    await page.waitForFunction(() => {
      const item = document.querySelector('.sp-msg .sp-progress-item')
      const wrap = item?.querySelector('.el-collapse-item__wrap')
      return item?.classList.contains('is-active') && wrap instanceof HTMLElement && wrap.clientHeight > 0
    }, undefined, { timeout: 1500 }).catch(() => {})
    const timeline = runtimeRow.locator('.sp-progress-timeline .el-timeline-item')
    const activeClass = await progressItem.evaluate((item) => item.classList.contains('is-active')).catch(() => false)
    const timelineBox = await runtimeRow.locator('.sp-progress-timeline').boundingBox().catch(() => null)
    const composerBox = await page.locator('.sp-composer').boundingBox().catch(() => null)
    const timelineLabels = await runtimeRow.locator('.sp-progress-timeline').innerText()
    await page.waitForFunction((runId) => {
      const timeline = document.querySelector(`[data-progress-id="${runId}"] .sp-progress-timeline`)
      const composer = document.querySelector('.sp-composer')
      if (!timeline || !composer) return false
      return timeline.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top
    }, runId, { timeout: 2000 }).catch(() => {})
    const visibleTimelineBox = await runtimeRow.locator('.sp-progress-timeline').boundingBox().catch(() => null)
    const composerTop = await page.locator('.sp-composer').evaluate((el) => el.getBoundingClientRect().top)
    const timelineVisible = activeClass && Boolean(visibleTimelineBox?.height) && await timeline.count() === 2 && timelineLabels.includes('整理会话、记忆与知识库上下文') &&
      timelineLabels.includes('正在请求模型，等待首个响应') && Boolean(visibleTimelineBox &&
        visibleTimelineBox.y + visibleTimelineBox.height <= composerTop)
    await page.screenshot({ path: '/tmp/ui-agent-progress-expanded.png' })
    detail.push(`重连快照恢复阶段且展开后为有序时间线=${timelineVisible}`)
    ok &&= timelineVisible
    await page.evaluate(() => {
      window.__uiVerifyRealDateNow = Date.now
      const baseline = Date.now()
      Date.now = () => baseline + 60_000
    })
    syntheticClockInstalled = true
    const degradedNotice = page.locator('.sp-live-connection').filter({ hasText: 'Agent 实时进度超过 45 秒未更新' })
    await degradedNotice.waitFor({ state: 'visible', timeout: 7000 })
    const degradedText = await degradedNotice.innerText()
    const networkStallVisible = degradedText.includes('运行状态仍保存在服务端') &&
      degradedText.includes('正在请求模型，等待首个响应') &&
      degradedText.includes('本阶段 1 分') && degradedText.includes('最近进度 1 分')
    detail.push(`Agent 阶段停滞时直接显示具体阶段、阶段用时、最近进度与服务端保留说明=${networkStallVisible}`)
    ok &&= networkStallVisible
    await page.evaluate(({ sessionId, sourceEventId, runId }) => {
      const socket = window.__uiVerifySockets?.find((item) => item.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'space:agent-progress', body: {
          runId: 'ui-global-queue-run', sessionId: 's_other_running', agentId: 'agent.coder',
          title: '编码者', sourceEventId: 'ui-global-queue-source',
          phase: 'waiting-model', at: new Date(Date.now()).toISOString(),
        },
      }) }))
    }, { sessionId, sourceEventId, runId })
    await degradedNotice.waitFor({ state: 'hidden', timeout: 1500 })
    const heartbeatHeader = await waitingHeader.innerText()
    const queueAfterHeartbeat = await queueSection.innerText()
    const heartbeatRestoresLiveState = heartbeatHeader.includes('正在请求模型，等待首个响应') &&
      heartbeatHeader.includes('本阶段 1 分') && queueAfterHeartbeat.includes('正在请求模型，等待首个响应') &&
      queueAfterHeartbeat.includes('本阶段 1 分') && /最近进度 [01] 秒前/u.test(queueAfterHeartbeat)
    detail.push(`同阶段心跳恢复实时状态且阶段计时不归零=${heartbeatRestoresLiveState}（气泡：${heartbeatHeader.trim()}；队列：${queueAfterHeartbeat.trim()}）`)
    ok &&= heartbeatRestoresLiveState
    await page.evaluate(() => {
      if (window.__uiVerifyRealDateNow) Date.now = window.__uiVerifyRealDateNow
      delete window.__uiVerifyRealDateNow
    })
    syntheticClockInstalled = false
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })
    const restoredRow = page.locator('.sp-msg').filter({ hasText: '需求分析师 · 正在工作' }).last()
    await restoredRow.waitFor({ state: 'visible', timeout: 3000 })
    const restoredHeader = await restoredRow.locator('.sp-progress-card .el-collapse-item__header').innerText()
    const refreshKeepsWorklog = restoredHeader.includes('正在请求模型，等待首个响应')
    detail.push(`刷新后从本地进度快照恢复工作记录卡片与当前阶段=${refreshKeepsWorklog}（${restoredHeader.trim()}）`)
    ok &&= refreshKeepsWorklog
    // Remove the synthetic run from the test browser so later UI scenarios do
    // not inherit it as if it were real user work.
    await page.evaluate((runId) => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith('space_agent_progress_v1_')) continue
        try {
          const runs = JSON.parse(localStorage.getItem(key) ?? '[]')
          localStorage.setItem(key, JSON.stringify(runs.filter((run) => run.runId !== runId)))
        } catch { /* ignore invalid fixture state */ }
      }
    }, runId)
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })
  } catch (e) {
    ok = false
    detail.push('异常:' + String(e).slice(0, 140))
    if (syntheticClockInstalled) await page.evaluate(() => {
      if (window.__uiVerifyRealDateNow) Date.now = window.__uiVerifyRealDateNow
      delete window.__uiVerifyRealDateNow
    }).catch(() => {})
  }
  judge('AS16 回复准备状态即时显示并无缝交接运行进度', ok, detail.join(' | '))
}

// A final failure event must retain a collapsible work record after the live
// progress row has been replaced by the persisted transcript.
{
  let ok = true; const detail = []
  const sessionId = new URL(page.url()).searchParams.get('session')
  if (!sessionId) throw new Error(`AS17 当前 URL 缺少 session 参数：${page.url()}`)
  const eventId = `ui-worklog-${randomUUID()}`
  const legacyEventId = `ui-worklog-legacy-${randomUUID()}`
  const startedAt = Date.now() - 3_000
  const worklogSteps = [
    '开始处理任务',
    '准备专属工作区',
    '正在请求模型，等待首个响应',
    '调用工具：读取工作区文件',
    '执行失败',
  ].map((label, index) => ({ label, at: new Date(startedAt + index * 1_000).toISOString(), kind: index === 3 ? 'tool' : 'phase',
    ...(index === 3 ? { status: 'failed', toolId: 'tool.workspace.read', inputSummary: '{"path":"projects/demo/src/app.ts"}', resultSummary: '文件读取失败：路径不存在', durationMs: 42 } : {}) }))
  const toolCalls = JSON.stringify([{ name: 'agent.worklog', args: JSON.stringify(worklogSteps) }])
  const db = new DatabaseSync('data/database.db')
  try {
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?').get(sessionId).next
    db.prepare(`INSERT INTO events (id, session_id, seq, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode)
      VALUES (?, ?, ?, ?, 'a_analyst', 'agent', 'message', '【执行失败】需求分析师 未能完成任务：模拟验收失败', '[]', ?, '')`)
      .run(eventId, sessionId, seq, new Date().toISOString(), toolCalls)
    db.prepare(`INSERT INTO events (id, session_id, seq, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode)
      VALUES (?, ?, ?, ?, 'agent.coder', 'agent', 'message', '【执行失败】编码者 未能完成任务：LLM 请求失败：fetch failed', '[]', '[]', '')`)
      .run(legacyEventId, sessionId, seq + 1, new Date().toISOString())
  } finally { db.close() }
  try {
    await page.goto(`${teamspaceBase}/teamspace?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle' })
    const row = page.locator(`[data-ev-id="${eventId}"]`)
    await row.waitFor({ state: 'visible', timeout: 5000 })
    const worklogHeader = row.locator('.sp-progress-card .el-collapse-item__header')
    const shown = await worklogHeader.innerText()
    const collapsedByDefault = !(await row.locator('.sp-progress-item').first().evaluate((item) => item.classList.contains('is-active')))
    const headerOk = shown.includes('工作记录') && shown.includes('5 步')
    await worklogHeader.click()
    const timeline = row.locator('.sp-progress-timeline')
    await timeline.waitFor({ state: 'visible', timeout: 3000 })
    const timelineText = await timeline.innerText()
    const labelsInOrder = ['开始处理任务', '准备专属工作区', '正在请求模型，等待首个响应', '调用工具：读取工作区文件', '执行失败']
    const positions = labelsInOrder.map((label) => timelineText.indexOf(label))
    const detailedStagesVisible = await timeline.locator('.el-timeline-item').count() === labelsInOrder.length &&
      positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1])
    const toolDetails = timelineText.includes('工具输入摘要') && timelineText.includes('projects/demo/src/app.ts') &&
      timelineText.includes('工具结果') && timelineText.includes('路径不存在') && timelineText.includes('42 ms')
    const okRow = collapsedByDefault && headerOk && detailedStagesVisible && toolDetails
    detail.push(`失败回执默认折叠=${collapsedByDefault} | 折叠头显示完整步数=${headerOk}（${shown.trim()}） | 展开后阶段完整且按序=${detailedStagesVisible} | 工具输入/结果/耗时详情可见=${toolDetails}${toolDetails ? '' : `（${JSON.stringify(timelineText.slice(-500))}）`}`)
    ok &&= okRow

    const legacyRow = page.locator(`[data-ev-id="${legacyEventId}"]`)
    await legacyRow.waitFor({ state: 'visible', timeout: 5000 })
    const legacyHeader = await legacyRow.locator('.sp-progress-card .el-collapse-item__header').innerText()
    const legacyFallbackVisible = legacyHeader.includes('工作记录') && legacyHeader.includes('1 步')
    detail.push(`旧失败记录没有阶段数据时仍显示可折叠说明=${legacyFallbackVisible}（${legacyHeader.trim()}）`)
    ok &&= legacyFallbackVisible
  } catch (error) {
    ok = false
    detail.push('验收异常：' + String(error).slice(0, 140))
  } finally {
    const cleanup = new DatabaseSync('data/database.db')
    try {
      for (const id of [eventId, legacyEventId]) {
        const event = cleanup.prepare('SELECT rowid, text FROM events WHERE id = ?').get(id)
        if (event) {
          cleanup.prepare("INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', ?, ?)")
            .run(event.rowid, event.text)
          cleanup.prepare('DELETE FROM events WHERE id = ?').run(id)
        }
      }
    } finally { cleanup.close() }
  }
  judge('AS17 Agent 失败回执保留可折叠工作记录', ok, detail.join(' | '))
}

// Paused @ requests expose a safe, editable retry action instead of resending
// the original task automatically.
{
  let ok = true; const detail = []
  const sessionId = new URL(page.url()).searchParams.get('session')
  if (!sessionId) throw new Error(`AS18 当前 URL 缺少 session 参数：${page.url()}`)
  const sourceId = `ui-retry-source-${randomUUID()}`
  const noticeId = `ui-retry-notice-${randomUUID()}`
  const sourceText = '@a_analyst 请重新检查这条验收请求'
  const db = new DatabaseSync('data/database.db')
  try {
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?').get(sessionId).next
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO events (id, session_id, seq, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode)
      VALUES (?, ?, ?, ?, 'u_ui_verify', 'human', 'message', ?, '["a_analyst"]', '[]', '')`)
      .run(sourceId, sessionId, seq, now, sourceText)
    db.prepare(`INSERT INTO events (id, session_id, seq, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode, source_event_id)
      VALUES (?, ?, ?, ?, NULL, 'system', 'system', 'Agent 尚未完成此前消息的顺序处理，本次回复已暂停，请稍后重试。', '[]', '[]', '', ?)`)
      .run(noticeId, sessionId, seq + 1, now, sourceId)
  } finally { db.close() }
  try {
    await page.goto(`${teamspaceBase}/teamspace?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle' })
    const row = page.locator(`[data-ev-id="${noticeId}"]`)
    await row.waitFor({ state: 'visible', timeout: 5000 })
    await row.getByRole('button', { name: '重新编辑请求' }).click()
    const draftRestored = await ta.inputValue() === sourceText
    detail.push(`暂停提示恢复原请求到输入框，未自动重发=${draftRestored}`)
    ok &&= draftRestored
  } catch (error) {
    ok = false
    detail.push('验收异常：' + String(error).slice(0, 140))
  } finally {
    const cleanup = new DatabaseSync('data/database.db')
    try {
      // The system notice points at the original event through a foreign key.
      for (const id of [noticeId, sourceId]) {
        const event = cleanup.prepare('SELECT rowid, text FROM events WHERE id = ?').get(id)
        if (!event) continue
        cleanup.prepare("INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', ?, ?)")
          .run(event.rowid, event.text)
        cleanup.prepare('DELETE FROM events WHERE id = ?').run(id)
      }
    } finally { cleanup.close() }
  }
  judge('AS18 顺序暂停可恢复原请求并由用户确认重发', ok, detail.join(' | '))
}

// Markdown remains structured when an Agent response ends with an unclosed
// fenced block, and common rich blocks remain readable in the real transcript.
{
  let ok = true; const detail = []
  const sessionId = new URL(page.url()).searchParams.get('session')
  if (!sessionId) throw new Error(`AS19 当前 URL 缺少 session 参数：${page.url()}`)
  const eventId = `ui-markdown-${randomUUID()}`
  const markdownText = [
    '## 验收报告', '',
    '| 阶段 | 状态 |', '| --- | --- |', '| 请求模型 | 等待响应 |', '',
    '```typescript', 'const answer: number = 42',
  ].join('\n')
  const db = new DatabaseSync('data/database.db')
  try {
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?').get(sessionId).next
    db.prepare(`INSERT INTO events (id, session_id, seq, ts, author_id, author_kind, kind, text, mentions, tool_calls, reply_mode)
      VALUES (?, ?, ?, ?, 'a_analyst', 'agent', 'message', ?, '[]', '[]', '')`)
      .run(eventId, sessionId, seq, new Date().toISOString(), markdownText)
  } finally { db.close() }
  try {
    await page.goto(`${teamspaceBase}/teamspace?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle' })
    const row = page.locator(`[data-ev-id="${eventId}"]`)
    await row.waitFor({ state: 'visible', timeout: 5000 })
    const code = row.locator('.sp-md-code-block')
    const headingAndTable = await row.locator('.sp-md-prose').innerText()
    const codeText = await code.locator('pre code').innerText()
    const formatted = await code.count() === 1 &&
      await code.locator('.sp-md-code-language').innerText() === 'typescript' &&
      codeText.includes('const answer: number = 42') &&
      await code.locator('.hljs-keyword').count() > 0 &&
      await row.locator('.sp-md table tbody tr').count() === 1 &&
      headingAndTable.includes('验收报告') && headingAndTable.includes('请求模型') &&
      !(await row.innerText()).includes('```')
    detail.push(`无闭合围栏仍渲染语法高亮代码块，标题和表格保留=${formatted}`)
    ok &&= formatted
  } catch (error) {
    ok = false
    detail.push('验收异常：' + String(error).slice(0, 140))
  } finally {
    const cleanup = new DatabaseSync('data/database.db')
    try {
      const event = cleanup.prepare('SELECT rowid, text FROM events WHERE id = ?').get(eventId)
      if (event) {
        cleanup.prepare("INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', ?, ?)")
          .run(event.rowid, event.text)
        cleanup.prepare('DELETE FROM events WHERE id = ?').run(eventId)
      }
    } finally { cleanup.close() }
  }
  judge('AS19 Agent Markdown 尾部围栏容错并保留富文本布局', ok, detail.join(' | '))
}

// AS12 composer keeps @ mention discovery and does not expose slash commands.
{
  const placeholder = await ta.getAttribute('placeholder')
  await ta.fill('/')
  await page.waitForTimeout(300)
  const slashPopupCount = await page.locator('.el-popover:visible').count()
  const slashRemainsText = await ta.inputValue() === '/'
  const ok = placeholder === '输入消息 · @提及成员' && slashPopupCount === 0 && slashRemainsText
  judge('AS12 输入区只提供成员提及；斜杠文本按普通消息处理', ok,
    `placeholder=${placeholder ?? 'null'} | slashPopup=${slashPopupCount} | slashText=${slashRemainsText}`)
  const rows = page.locator('.sp-list .sp-msg[data-ev-id]')
  const beforeRows = await rows.count()
  const beforeSends = await page.evaluate(() => window.__uiVerifyRpcMethods.filter((method) => method === 'send').length)
  await ta.fill('   ')
  await page.getByRole('button', { name: '发送消息' }).click()
  const emptyAlert = page.locator('.el-alert').filter({ hasText: '内容不能为空' })
  await emptyAlert.waitFor({ state: 'visible', timeout: 2000 })
  const whitespaceRetained = (await ta.inputValue()) === '   '
  const rowsUnchanged = (await rows.count()) === beforeRows
  const sendsUnchanged = await page.evaluate((count) => window.__uiVerifyRpcMethods.filter((method) => method === 'send').length === count, beforeSends)
  judge('AS12a 纯空白消息显示原因且不入时间线、不调用发送 RPC',
    whitespaceRetained && rowsUnchanged && sendsUnchanged,
    `draftRetained=${whitespaceRetained} | timeline=${beforeRows}->${await rows.count()} | sendRpcUnchanged=${sendsUnchanged}`)
  await ta.fill('')
}

// AS13 failed operations remain independently visible until each is dismissed.
{
  let ok = true; const detail = []
  const uploadRoute = /\/api\/upload\?/
  let attempts = 0
  try {
    expectedUploadFailureResponses = true
    await page.route(uploadRoute, async (route) => {
      attempts++
      if (attempts === 1) return route.fulfill({ status: 413, contentType: 'text/plain', body: 'too large' })
      return route.abort('failed')
    })
    const upload = async (name) => {
      const chooserPending = page.waitForEvent('filechooser')
      await page.locator('.sp-attach').click()
      const chooser = await chooserPending
      await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('ui verification') })
    }
    await upload('oversized.txt')
    const oversized = page.locator('.el-alert__title').filter({ hasText: '文件过大（上限 20MB）' })
    const oversizedAlert = page.locator('.el-alert').filter({ hasText: '文件过大（上限 20MB）' })
    await oversized.waitFor({ timeout: 5000 })
    await upload('offline.txt')
    const network = page.locator('.el-alert__title').filter({ hasText: '上传文件失败，请检查网络后重试' })
    const networkAlert = page.locator('.el-alert').filter({ hasText: '上传文件失败，请检查网络后重试' })
    await network.waitFor({ timeout: 5000 })
    const distinctFailuresVisible = await oversized.count() === 1 && await network.count() === 1
    detail.push(`两种失败同时可见=${distinctFailuresVisible}`)
    ok &&= distinctFailuresVisible
    await oversizedAlert.locator('.el-alert__close-btn').click()
    await oversized.waitFor({ state: 'detached' })
    const otherFailureRemains = await network.count() === 1
    detail.push(`关闭一条后另一条保留=${otherFailureRemains}`)
    ok &&= otherFailureRemains
    await networkAlert.locator('.el-alert__close-btn').click()
    await network.waitFor({ state: 'detached' })
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 120)}`)
  } finally {
    await page.unroute(uploadRoute).catch(() => {})
    expectedUploadFailureResponses = false
  }
  judge('AS13 错误通知独立保留并逐条关闭', ok, detail.join(' | '))
}

// Opening a session starts at its latest event even when local read state says
// that older messages remain unread; historical review is an explicit action.
{
  let ok = true; const detail = []
  try {
    const token = await page.evaluate(() => localStorage.getItem('space_token'))
    const db = new DatabaseSync('data/database.db')
    let seenAt = 0
    try {
      const user = db.prepare('SELECT user_id FROM login_tokens WHERE token = ?').get(token)
      const rows = db.prepare(`SELECT id, ts, author_id, kind, voided FROM events
        WHERE session_id = 's_seed_demo' ORDER BY seq`).all()
      const start = Math.floor(rows.length / 2)
      seenAt = Date.parse(rows[start - 1]?.ts ?? '') || 0
      if (!rows.some((event) => event.kind === 'message' && event.author_id !== user?.user_id &&
        !event.voided && (Date.parse(event.ts) || 0) > seenAt)) throw new Error('no middle unread event in seeded transcript')
    } finally { db.close() }
    await page.evaluate((value) => localStorage.setItem('space_seen_s_seed_demo', String(value)), seenAt)
    await page.reload({ waitUntil: 'networkidle' })
    const rows = page.locator('.sp-list .sp-msg[data-ev-id]')
    await rows.last().waitFor({ timeout: 10000 })
    await page.waitForTimeout(200)
    const placement = await rows.last().evaluate((element) => {
      const wrap = document.querySelector('.content-body .el-scrollbar__wrap')
      const rowRect = element.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      return { rowBottom: rowRect.bottom, wrapBottom: wrapRect.bottom,
        gap: wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight }
    })
    const latestVisible = placement.rowBottom <= placement.wrapBottom + 12
    detail.push(`最新消息位于视口内=${latestVisible} | 滚动到底部距离=${Math.round(placement.gap)}px`)
    ok &&= latestVisible && placement.gap < 80
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  judge('AS6 初次进入会话始终定位最新消息', ok, detail.join(' | '))
}

// A viewport resize must preserve the message currently being read, even when
// narrow-screen wrapping changes the transcript's total height substantially.
{
  let ok = true; const detail = []
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(150)
    const rows = page.locator('.sp-list .sp-msg[data-ev-id]')
    const target = await rows.nth(Math.floor((await rows.count()) * 0.6)).getAttribute('data-ev-id')
    const wrap = page.locator('.content-body .el-scrollbar__wrap')
    await page.evaluate((id) => {
      const scroller = document.querySelector('.content-body .el-scrollbar__wrap')
      const row = document.querySelector(`.sp-msg[data-ev-id="${id}"]`)
      scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2
    }, target)
    await page.waitForTimeout(200)
    const anchor = await wrap.evaluate((element) => {
      const top = element.getBoundingClientRect().top
      const row = [...element.querySelectorAll('.sp-msg[data-ev-id]')]
        .find((item) => item.getBoundingClientRect().bottom > top)
      return row && { id: row.getAttribute('data-ev-id'), offset: row.getBoundingClientRect().top - top }
    })
    if (!anchor) throw new Error('resize 前未能捕获可见消息锚点')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
    const after = await page.locator(`.sp-msg[data-ev-id="${anchor.id}"]`).evaluate((row) => {
      const scroller = document.querySelector('.content-body .el-scrollbar__wrap')
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
    const drift = Math.abs(after - anchor.offset)
    detail.push(`同一消息=${anchor.id}，缩放前后偏移差=${Math.round(drift)}px`)
    ok &&= drift <= 12
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(300)
    await wrap.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.waitForTimeout(200)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
    const bottomGap = await wrap.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    detail.push(`贴底缩放后距最新=${Math.round(bottomGap)}px`)
    ok &&= bottomGap <= 80
    await page.setViewportSize({ width: 1440, height: 900 })
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  judge('AS9 窗口缩放保留阅读锚点与贴底状态', ok, detail.join(' | '))
}

console.log('== 常规回归（草稿 / 菜单 / 抽屉 / 消息卡）==')
await ta.fill('回归草稿，不发送')
console.log('草稿输入:', JSON.stringify(await ta.inputValue()))
await ta.fill('')
await ta.fill(''); await ta.pressSequentially('@a', { delay: 40 }); await page.waitForTimeout(400)
await ta.press('Enter'); await page.waitForTimeout(400)
console.log('@ 菜单 Enter 确认:', JSON.stringify(await ta.inputValue()))
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
    const toggle = page.locator('.sp-sidebar-toggle--left')
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
    await run('5抽屉开', async () => { await page.locator('.sp-sidebar-toggle--right').click(); await page.waitForTimeout(80) })
    await run('6抽屉关', async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(80) })
    await run('7toggle展开', () => toggle.click())
    await run('8toggle折叠', () => toggle.click())
    await run('9toggle展开', () => toggle.click())
    await run('10悬停消息', () => page.locator('.sp-list .sp-msg[data-ev-id]').first().hover())
    const maxMs = Math.max(...steps.map((x) => x[1]))
    detail.push(`10步耗时=${JSON.stringify(steps.map((x) => x[1]))}ms max=${maxMs}ms`)
    ok &&= maxMs < 1000
    if (!(await page.locator('aside.page-sidebar').count())) {
      await toggle.click()
      await page.waitForTimeout(150)
    }
    const restoredExpanded = (await page.locator('aside.page-sidebar').count()) === 1
    detail.push(`交互探针后恢复桌面会话栏=${restoredExpanded}`)
    ok &&= restoredExpanded
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
      await page.locator('.sp-sidebar-toggle--right').click()
    }
    const activityTab = page.locator('.right-sidebar .el-tabs__item').nth(1)
    await activityTab.click()
    const total = Number((await activityTab.innerText()).match(/\((\d+)\)/)?.[1] ?? 0)
    const cards = page.locator('.right-sidebar .sp-activity-item')
    const firstBatch = await cards.count()
    detail.push(`总数=${total} 初始卡片=${firstBatch}`)
    const cardBounds = await page.locator('.right-sidebar .el-tab-pane').nth(1).evaluate((pane) => {
      const right = pane.getBoundingClientRect().right
      const cards = Array.from(pane.querySelectorAll('.sp-activity-item'))
      return { paneRight: right, paneWidth: pane.getBoundingClientRect().width,
        sidebarWidth: pane.closest('.right-sidebar').getBoundingClientRect().width,
        cardRights: cards.map((card) => card.getBoundingClientRect().right) }
    })
    const cardsFit = cardBounds.cardRights.length > 0 && cardBounds.cardRights.every((right) => right <= cardBounds.paneRight + 1)
    detail.push(`活动卡片均在 Tab 内=${cardsFit}（Tab 右界=${Math.round(cardBounds.paneRight)}px，最右卡片=${Math.round(Math.max(...cardBounds.cardRights))}px）`)
    ok &&= cardsFit
    const sidebarFitsContent = cardBounds.sidebarWidth >= 280
    detail.push(`桌面协作栏宽度=${Math.round(cardBounds.sidebarWidth)}px（≥280px=${sidebarFitsContent}）`)
    ok &&= sidebarFitsContent
    // 额外卡片可能是正在运行的 Agent 进度卡，不属于历史活动批次。
    ok &&= firstBatch <= 110
    const more = page.getByRole('button', { name: /加载更早活动/ })
    if (total > firstBatch) {
      ok &&= await more.count() === 1
      await more.click()
      const nextBatch = await cards.count()
      detail.push(`加载后卡片=${nextBatch}`)
      ok &&= nextBatch > firstBatch && nextBatch <= 210
    }
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  const summaries = page.locator('.right-sidebar .sp-activity-feed .sp-activity-item .sp-activity-description')
  const summaryMetrics = await summaries.evaluateAll((nodes) => nodes.map((node) => ({
    height: node.getBoundingClientRect().height,
    width: node.getBoundingClientRect().width,
    cardWidth: node.closest('.sp-activity-item')?.getBoundingClientRect().width ?? 0,
    lineClamp: getComputedStyle(node).webkitLineClamp,
    title: node.getAttribute('title') ?? '',
  })))
  const compact = summaryMetrics.length > 0 && summaryMetrics.every((item) =>
    item.height <= 60 && item.width > 0 && item.width <= item.cardWidth + 1 &&
    item.lineClamp === '3' && item.title.length > 0)
  detail.push(`摘要最多三行且可查看完整内容=${compact ? '是' : '否'}（${summaryMetrics.length}项）`)
  ok &&= compact
  const db = new DatabaseSync('data/database.db')
  let knownAuthors, latestSystem
  try {
    const latestHuman = db.prepare(`SELECT e.seq, e.author_id, u.display_name
      FROM events e
        JOIN users u ON u.id=e.author_id
      WHERE e.session_id='s_seed_demo' AND e.author_id IS NOT NULL
        ORDER BY e.seq DESC LIMIT 1`).get()
    const latestAgent = db.prepare(`SELECT e.seq, e.author_id, a.title
        FROM events e
        JOIN agent_definitions a ON a.id=e.author_id
        WHERE e.session_id='s_seed_demo' AND e.author_id IS NOT NULL
        ORDER BY e.seq DESC LIMIT 1`).get()
    latestSystem = db.prepare(`SELECT seq FROM events
      WHERE session_id='s_seed_demo' AND kind='system' ORDER BY seq DESC LIMIT 1`).get()
    knownAuthors = [
      latestHuman && { ...latestHuman, displayName: latestHuman.display_name, kind: 'human' },
      latestAgent && { ...latestAgent, displayName: latestAgent.title, kind: 'agent' },
    ].filter(Boolean)
  } finally { db.close() }
  if (knownAuthors.length) {
    for (const author of knownAuthors) {
      const item = page.locator('.sp-activity-item').filter({ hasText: `#${author.seq}` }).first()
      const label = await item.locator('.sp-activity-meta').innerText()
      const readable = label.includes(author.displayName || '\u0000') && !label.includes(author.author_id)
      detail.push(`${author.kind === 'human' ? '人类' : 'Agent'}历史发言者显示名称=${readable}（${author.author_id}）`)
      ok &&= readable
    }
  } else {
    detail.push('没有可用于发言者名称映射的历史事件')
    ok = false
  }
  if (latestSystem) {
    const systemItem = page.locator('.sp-activity-item').filter({ hasText: `#${latestSystem.seq}` }).first()
    const summary = await systemItem.locator('.sp-activity-description').innerText()
    const localized = summary.startsWith('系统 ·') && !summary.startsWith('system ·')
    detail.push(`系统事件类型使用中文标签=${localized}`)
    ok &&= localized
  } else {
    detail.push('没有可用于系统事件类型映射的历史事件')
    ok = false
  }
  judge('AS4 活动日志按需分批渲染且摘要可追溯', ok, detail.join(' | '))
}

// AS7 Agent 创建器展示起始模板的显式版本，方便团队知道新建实例复制自哪一版。
{
  let ok = true; const detail = []
  let agentContext
  let templateTestTitle = ''
  try {
    const token = await page.evaluate(() => localStorage.getItem('space_token'))
    agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await agentContext.addInitScript((value) => localStorage.setItem('space_token', value), token)
    const agentPage = await agentContext.newPage()
    const agentErrors = []
    agentPage.on('pageerror', (e) => agentErrors.push(String(e).slice(0, 120)))
    await agentPage.goto(`${teamspaceBase}/teamspace/agents`, { waitUntil: 'networkidle', timeout: 20000 })
    const redundantNavigationRemoved = !(await agentPage.getByText('返回会话', { exact: true }).count()) &&
      !(await agentPage.getByText('团队共享资源', { exact: true }).count())
    const topBarRemoved = await agentPage.locator('.sp-agent-directory-page').evaluate((element) => {
      const header = element.closest('.sp-compact-header-layout')?.querySelector('.layout-header')
      return Boolean(header && getComputedStyle(header).display === 'none' && header.getBoundingClientRect().height === 0)
    })
    detail.push(`重复回退栏、资源徽标和空顶栏已移除=${redundantNavigationRemoved && topBarRemoved}`)
    ok &&= redundantNavigationRemoved && topBarRemoved
    const fontFamily = await agentPage.locator('.k-layout').evaluate((element) => getComputedStyle(element).fontFamily)
    const genericFamily = fontFamily.split(',').at(-1)?.trim().replace(/^['"]|['"]$/g, '')
    detail.push(`共享无衬线字体=${fontFamily}`)
    ok &&= genericFamily === 'sans-serif'
    const agentTab = agentPage.getByRole('tab', { name: 'Agent 管理' })
    const promptTab = agentPage.getByRole('tab', { name: '共享提示词' })
    await agentPage.getByRole('button', { name: '新建 Agent' }).click()
    await agentPage.locator('.sp-agent-form-card').waitFor({ timeout: 5000 })
    const formBox = await agentPage.locator('.sp-agent-form-card').boundingBox()
    const listBox = await agentPage.locator('.sp-agent-list-card').boundingBox()
    const agentForm = agentPage.locator('.sp-agent-form-card')
    const formGroups = await agentForm.locator('.sp-agent-form-grid .el-divider__text').allTextContents()
    const groupedForm = formGroups.join('|') === '角色与模板|模型与提示词|工具与上下文|记忆与发言策略'
    detail.push(`配置表单按职责分组=${groupedForm}（${formGroups.join(' / ')}）`)
    ok &&= groupedForm
    const formColumns = await agentForm.locator('.sp-agent-form-grid').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length)
    await agentPage.getByRole('button', { name: '＋ 设置团队模板（可选）' }).click()
    const emptyAgentSaveDisabled = await agentPage.getByRole('button', { name: '创建 Agent' }).isDisabled()
    const emptyTemplateSaveDisabled = await agentPage.getByRole('button', { name: '另存为团队模板' }).isDisabled()
    detail.push(`必填信息为空时阻止提交=${emptyAgentSaveDisabled && emptyTemplateSaveDisabled}`)
    ok &&= emptyAgentSaveDisabled && emptyTemplateSaveDisabled
    const rightSideEditor = Boolean(formBox && listBox && formBox.width >= 600 && formBox.x > listBox.x && formColumns === 2 &&
      await agentTab.getAttribute('aria-selected') === 'true')
    detail.push(`Agent 列表左置、表单右侧编辑=${rightSideEditor}（表单宽=${Math.round(formBox?.width ?? 0)}px，列数=${formColumns}）`)
    ok &&= rightSideEditor
    await agentPage.screenshot({ path: '/tmp/ui-agent-management-final.png' })
    await promptTab.click()
    const promptEditorSeparated = await agentPage.locator('.sp-agent-prompt-editor').isVisible()
    const promptColumns = await agentPage.evaluate(() => {
      const directory = document.querySelector('.sp-agent-prompt-directory')
      const main = document.querySelector('.sp-agent-prompt-main')
      const page = document.querySelector('.sp-agent-directory-page .sp-agent-page-inner')
      return { directory: directory?.getBoundingClientRect().width ?? 0, main: main?.getBoundingClientRect().width ?? 0,
        pageWidth: page?.getBoundingClientRect().width ?? 0, viewportWidth: innerWidth }
    })
    const promptListHasRoom = promptColumns.directory / promptColumns.main >= 0.42 && promptColumns.pageWidth >= promptColumns.viewportWidth * 0.9
    detail.push(`共享提示词列表与页面充分利用可用宽度=${promptListHasRoom}（页面 ${Math.round(promptColumns.pageWidth)}/${Math.round(promptColumns.viewportWidth)}px，目录/编辑区 ${Math.round(promptColumns.directory)}/${Math.round(promptColumns.main)}px）`)
    ok &&= promptListHasRoom
    const promptAlignment = await agentPage.locator('.sp-agent-prompt-menu-item').first().evaluate((element) => {
      const labels = [...element.querySelectorAll('.el-text')]
      const leftEdges = labels.map((label) => label.getBoundingClientRect().left)
      return getComputedStyle(element).textAlign === 'left' && labels.length === 2 &&
        labels.every((label) => getComputedStyle(label).textAlign === 'left') && Math.abs(leftEdges[0] - leftEdges[1]) < 1
    })
    await agentTab.click()
    detail.push(`共享提示词独立标签页=${promptEditorSeparated && !(await agentPage.locator('.sp-agent-prompt-editor').isVisible())}`)
    ok &&= promptEditorSeparated && !(await agentPage.locator('.sp-agent-prompt-editor').isVisible())
    detail.push(`共享提示词名称与 ref 统一左对齐=${promptAlignment}`)
    ok &&= promptAlignment
    await agentPage.getByText('创建模板', { exact: true }).locator('xpath=..').locator('.el-select').click()
    const versionOptions = agentPage.locator('.el-popper:visible .el-select-dropdown__item')
    await versionOptions.first().waitFor({ timeout: 5000 })
    const options = await versionOptions.allTextContents()
    const versioned = options.filter((text) => /\sv\d+：/.test(text))
    detail.push(`有版本标识的模板=${versioned.length}（${versioned.join(' / ')}）`)
    const starterIds = ['研究与分析', '方案挑战', '代码实现', '代码审查', '测试设计', '通用协作']
    const hasStarters = starterIds.every((name) => options.some((text) => text.includes(name)))
    detail.push(`六个内置起始模板=${hasStarters}`)
    ok &&= versioned.length >= 6 && hasStarters && agentErrors.length === 0
    templateTestTitle = `UI验收模板-${Date.now()}`
    await versionOptions.first().click()
    const templateDefaultsReady = !(await agentPage.getByRole('button', { name: '创建 Agent' }).isDisabled()) &&
      !(await agentPage.getByRole('button', { name: '另存为团队模板' }).isDisabled())
    detail.push(`选用模板后有效字段自动解锁提交=${templateDefaultsReady}`)
    ok &&= templateDefaultsReady
    await agentPage.locator('input[placeholder="例如：发布验收助手"]').fill(templateTestTitle)
    await agentPage.locator('input[placeholder="简要说明这个模板适合什么工作"]').fill('验证团队模板共享和版本递增')
    await agentPage.getByRole('button', { name: '另存为团队模板' }).click()
    await agentPage.getByText(new RegExp(`团队模板「${templateTestTitle}」已保存为 v1`)).waitFor({ timeout: 8000 })
    const db = new DatabaseSync('data/database.db')
    try {
      let rows = db.prepare('SELECT id, version, summary, status FROM agent_templates WHERE title = ? ORDER BY version').all(templateTestTitle)
      const versionOne = rows.length === 1 && rows[0].version === 1
      detail.push(`团队模板 v1 持久化=${versionOne}`)
      ok &&= versionOne
      await agentPage.getByText('创建模板', { exact: true }).locator('xpath=..').locator('.el-select').click()
      await agentPage.locator('.el-popper:visible .el-select-dropdown__item').filter({ hasText: templateTestTitle }).click()
      await agentPage.locator('input[placeholder="简要说明这个模板适合什么工作"]').fill('二版说明')
      await agentPage.getByRole('button', { name: '保存为所选模板新版本' }).click()
      await agentPage.getByText(new RegExp(`团队模板「${templateTestTitle}」已保存为 v2`)).waitFor({ timeout: 8000 })
      rows = db.prepare('SELECT id, version, summary, status FROM agent_templates WHERE title = ? ORDER BY version').all(templateTestTitle)
      const revisioned = rows.length === 2 && rows[0].version === 1 && rows[1].version === 2 && rows[1].summary === '二版说明'
      detail.push(`v2 追加且保留 v1=${revisioned}`)
      ok &&= revisioned
      await agentPage.getByRole('button', { name: '归档所选模板' }).click()
      await agentPage.getByRole('button', { name: '归档模板', exact: true }).click()
      await agentPage.getByText(new RegExp(`已归档团队模板「${templateTestTitle}」`)).waitFor({ timeout: 8000 })
      rows = db.prepare('SELECT id, version, summary, status FROM agent_templates WHERE title = ? ORDER BY version').all(templateTestTitle)
      const archived = rows.length === 2 && rows.every((row) => row.status === 'archived')
      detail.push(`归档保留两版且统一隐藏=${archived}`)
      ok &&= archived
      await agentPage.getByRole('button', { name: '显示归档模板' }).click()
      await agentPage.getByText('创建模板', { exact: true }).locator('xpath=..').locator('.el-select').click()
      await agentPage.locator('.el-popper:visible .el-select-dropdown__item').filter({ hasText: templateTestTitle }).click()
      await agentPage.getByRole('button', { name: '恢复所选模板' }).click()
      await agentPage.getByText(new RegExp(`已恢复团队模板「${templateTestTitle}」`)).waitFor({ timeout: 8000 })
      rows = db.prepare('SELECT id, version, summary, status FROM agent_templates WHERE title = ? ORDER BY version').all(templateTestTitle)
      const restored = rows.length === 2 && rows.every((row) => row.status === 'active')
      detail.push(`恢复后历史版本仍在=${restored}`)
      ok &&= restored
    } finally {
      db.prepare('DELETE FROM agent_templates WHERE title = ?').run(templateTestTitle)
      db.close()
    }
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 100)) }
  finally {
    if (templateTestTitle) {
      const db = new DatabaseSync('data/database.db')
      try { db.prepare('DELETE FROM agent_templates WHERE title = ?').run(templateTestTitle) }
      finally { db.close() }
    }
    await agentContext?.close()
  }
  judge('AS7 团队 Agent 创建器展示版本并保存共享模板', ok, detail.join(' | '))
}

// AS8 Agent management selects an entry in the left pane and edits it in the right pane.
{
  let ok = true; const detail = []
  try {
    await page.goto(`${teamspaceBase}/teamspace/agents`, { waitUntil: 'networkidle', timeout: 20000 })
    const entries = page.locator('.sp-agent-menu .el-menu-item')
    await entries.nth(1).waitFor({ timeout: 10000 })
    await entries.nth(1).click()
    await page.locator('.sp-agent-form-card').waitFor({ state: 'visible', timeout: 5000 })
    const panes = await page.evaluate(() => {
      const list = document.querySelector('.sp-agent-master-column')?.getBoundingClientRect()
      const editor = document.querySelector('.sp-agent-detail-column')?.getBoundingClientRect()
      return { listRight: list?.right ?? 0, editorLeft: editor?.left ?? 0, editorWidth: editor?.width ?? 0 }
    })
    const editorRight = panes.editorWidth > 0 && panes.listRight <= panes.editorLeft
    detail.push(`选择列表项后右侧打开编辑器=true、左栏右界=${panes.listRight}px、右栏左界=${panes.editorLeft}px、编辑区宽=${panes.editorWidth}px`)
    ok &&= editorRight
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 120)) }
  judge('AS8 Agent 管理页左侧选择与右侧编辑', ok, detail.join(' | '))
}

// The memory explorer stays inside the application viewport; only its table scrolls.
{
  let ok = true; const detail = []
  try {
    await page.goto(`${teamspaceBase}/teamspace/memories`, { waitUntil: 'networkidle', timeout: 20000 })
    await page.getByRole('heading', { name: '记忆库' }).waitFor({ timeout: 10000 })
    const metrics = await page.evaluate(() => {
      const root = document.scrollingElement
      const page = document.querySelector('.sp-memory-page')
      const pagination = document.querySelector('.sp-memory-page .sp-memory-pagination')
      const agentScroller = document.querySelector('.sp-memory-agent-scroll .el-scrollbar__wrap')
      const folderScroller = document.querySelector('.sp-memory-folder-scroll .el-scrollbar__wrap')
      const table = document.querySelector('.sp-memory-list-card .el-table')
      const header = table?.querySelector('.el-table__header-wrapper')
      const listBody = document.querySelector('.sp-memory-list-card .el-card__body')
      const tableHeaders = [...(header?.querySelectorAll('th') ?? [])].filter((cell) => getComputedStyle(cell).display !== 'none')
      const listRect = listBody?.getBoundingClientRect()
      const columnsVisible = Boolean(listRect && table && tableHeaders.length >= 4 && table.offsetWidth <= (listBody?.clientWidth ?? 0) + 1 && tableHeaders.every((cell) => {
        const rect = cell.getBoundingClientRect()
        return rect.width > 0 && rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1
      }))
      const paginationRect = pagination?.getBoundingClientRect()
      return {
        documentOverflow: Boolean(root && root.scrollHeight > root.clientHeight + 1),
        pageOverflow: Boolean(page && page.scrollHeight > page.clientHeight + 1),
        paginationVisible: Boolean(paginationRect && paginationRect.top >= 0 && paginationRect.bottom <= innerHeight),
        agentListConstrained: Boolean(agentScroller && agentScroller.clientHeight > 0 && getComputedStyle(agentScroller).overflowY !== 'visible'),
        folderTreeConstrained: Boolean(folderScroller && folderScroller.clientHeight > 0 && getComputedStyle(folderScroller).overflowY !== 'visible'),
        columnsVisible,
        redundantNavigationRemoved: !document.body.innerText.includes('返回会话'),
        topBarRemoved: Boolean(page?.closest('.sp-compact-header-layout')?.querySelector('.layout-header') &&
          getComputedStyle(page.closest('.sp-compact-header-layout').querySelector('.layout-header')).display === 'none'),
        pageUsesViewport: Boolean(page && page.getBoundingClientRect().width >= innerWidth * 0.9),
      }
    })
    detail.push(`document 无滚动=${!metrics.documentOverflow} | 页面容器无滚动=${!metrics.pageOverflow} | Agent 列表内部可滚动=${metrics.agentListConstrained} | 文件夹树内部可滚动=${metrics.folderTreeConstrained} | 分页控件在视口内=${metrics.paginationVisible} | 表格列完整位于面板内=${metrics.columnsVisible} | 重复导航与空顶栏已移除=${metrics.redundantNavigationRemoved && metrics.topBarRemoved} | 页面使用视口宽度=${metrics.pageUsesViewport}`)
    ok &&= !metrics.documentOverflow && !metrics.pageOverflow && metrics.paginationVisible && metrics.agentListConstrained && metrics.folderTreeConstrained && metrics.columnsVisible && metrics.redundantNavigationRemoved && metrics.topBarRemoved && metrics.pageUsesViewport
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 120)) }
  judge('AS28 记忆库固定视口并仅列表内部滚动', ok, detail.join(' | '))
}

// The selected memory and its metadata share one readable, internally scrollable drawer.
{
  let ok = true; const detail = []
  try {
    const firstMemory = page.locator('.sp-memory-list-card .el-table__row').filter({ hasText: '记忆详情长文本换行验收' }).first()
    await firstMemory.waitFor({ timeout: 10000 })
    await firstMemory.click()
    const drawer = page.locator('.el-drawer').filter({ has: page.getByRole('heading', { name: '记忆详情' }) })
    await drawer.waitFor({ state: 'visible', timeout: 5000 })
    const initial = await drawer.evaluate((element) => {
      const scroll = element.querySelector('.el-drawer__body .el-scrollbar')
      const viewport = scroll?.querySelector('.el-scrollbar__wrap')
      const text = element.querySelector('.el-drawer__body textarea')
      const metadata = element.querySelector('.el-descriptions')
      const move = [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === '移动')
      return {
        oneScrollRegion: Boolean(viewport && text && metadata && move && viewport.contains(text) && viewport.contains(metadata) && viewport.contains(move)),
        textWraps: Boolean(text && text.readOnly && text.wrap !== 'off' && text.value.includes('记忆详情长文本换行验收') && text.value.length > 3000 && text.clientWidth > 0 && text.scrollWidth <= text.clientWidth + 1),
        scrollable: Boolean(viewport && viewport.scrollHeight > viewport.clientHeight + 20),
      }
    })
    await drawer.locator('.el-scrollbar__wrap').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.waitForTimeout(50)
    const controlsReachable = await drawer.evaluate((element) => {
      const viewport = element.querySelector('.el-drawer__body .el-scrollbar__wrap')
      const metadata = element.querySelector('.el-descriptions')
      const move = [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === '移动')
      const viewportRect = viewport?.getBoundingClientRect()
      const metadataRect = metadata?.getBoundingClientRect()
      const moveRect = move?.getBoundingClientRect()
      return Boolean(viewport && viewport.scrollTop > 0 && viewportRect && metadataRect && moveRect &&
        metadataRect.top >= viewportRect.top && metadataRect.bottom <= viewportRect.bottom + 1 &&
        moveRect.top >= viewportRect.top && moveRect.bottom <= viewportRect.bottom + 1)
    })
    detail.push(`长夹具正文自然换行=${initial.textWraps} | 正文、元信息、移动操作共用滚动区=${initial.oneScrollRegion} | 长内容产生内部滚动=${initial.scrollable} | 滚到底部后元信息和操作可达=${controlsReachable}`)
    ok &&= initial.textWraps && initial.oneScrollRegion && initial.scrollable && controlsReachable
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 120)) }
  judge('AS32 记忆详情正文换行且完整内容可在抽屉内滚动', ok, detail.join(' | '))
}

// Agent management and workspace pages keep scrolling inside their content panes.
{
  let ok = true; const detail = []
  for (const item of [
    { path: '/teamspace/agents', heading: '团队共享 Agent', selector: '.sp-agent-directory-page' },
    { path: '/teamspace/workspaces', heading: 'Agent 工作区', selector: '.sp-workspace-page' },
  ]) {
    try {
      if (item.path === '/teamspace/workspaces') await page.setViewportSize({ width: 1100, height: 720 })
      await page.goto(`${teamspaceBase}${item.path}`, { waitUntil: 'networkidle', timeout: 20000 })
      await page.getByRole('heading', { name: item.heading }).waitFor({ timeout: 10000 })
      if (item.path === '/teamspace/workspaces') {
        await page.getByText('团队 Agent', { exact: true }).waitFor({ timeout: 5000 })
        await page.getByRole('tab', { name: '文件' }).waitFor({ timeout: 5000 })
      }
      const redundantNavigationRemoved = !(await page.getByText('返回会话', { exact: true }).count())
      const workspaceHelpRemoved = item.path !== '/teamspace/workspaces' || !(await page.getByText('工作区目录规范', { exact: true }).count())
      const topBarRemoved = await page.locator(item.selector).evaluate((element) => {
        const header = element.closest('.sp-compact-header-layout')?.querySelector('.layout-header')
        return Boolean(header && getComputedStyle(header).display === 'none' && header.getBoundingClientRect().height === 0)
      })
      const pageUsesViewport = await page.locator(item.selector).locator('.sp-agent-page-inner').evaluate((element) => element.getBoundingClientRect().width >= innerWidth * 0.9)
      detail.push(`${item.path}: 重复导航与空顶栏移除=${redundantNavigationRemoved && topBarRemoved} | 页面充分利用可用宽度=${pageUsesViewport} | 占空间的目录说明移除=${workspaceHelpRemoved}`)
      ok &&= redundantNavigationRemoved && topBarRemoved && workspaceHelpRemoved && pageUsesViewport
      const metrics = await page.evaluate(({ selector, needsAgentScroll }) => {
        const root = document.scrollingElement
        const surface = document.querySelector(selector)
        const agentScroller = needsAgentScroll ? document.querySelector('.sp-workspace-agent-scroll .el-scrollbar__wrap') : null
        const treeScroller = needsAgentScroll ? document.querySelector('.sp-workspace-tree-scroll .el-scrollbar__wrap') : null
        const treeScrollbar = needsAgentScroll ? document.querySelector('.sp-workspace-tree-scroll .el-scrollbar__bar.is-vertical') : null
        const tabsViewport = needsAgentScroll ? document.querySelector('.sp-workspace-tabs .el-tabs__nav-wrap') : null
        const tabsContent = needsAgentScroll ? document.querySelector('.sp-workspace-tabs .el-tabs__content') : null
        const workspaceCard = needsAgentScroll ? document.querySelector('.sp-workspace-page .sp-agent-explorer > .el-col:last-child .el-card') : null
        const agentScrollbar = needsAgentScroll ? document.querySelector('.sp-workspace-agent-scroll .el-scrollbar__bar.is-vertical') : null
        return {
          documentOverflow: Boolean(root && root.scrollHeight > root.clientHeight + 1),
          surfaceOverflow: Boolean(surface && surface.scrollHeight > surface.clientHeight + 1),
          workspaceContentOverflow: Boolean(surface?.querySelector('.sp-agent-page-inner') &&
            surface.querySelector('.sp-agent-page-inner').scrollHeight > surface.querySelector('.sp-agent-page-inner').clientHeight + 1),
          agentListConstrained: !needsAgentScroll || Boolean(agentScroller && agentScroller.clientHeight > 0 && agentScroller.scrollHeight > agentScroller.clientHeight + 1 && getComputedStyle(agentScroller).overflowY === 'scroll'),
          agentScrollbarVisible: !needsAgentScroll || Boolean(agentScrollbar && getComputedStyle(agentScrollbar).display !== 'none' && getComputedStyle(agentScrollbar).visibility !== 'hidden' && Number.parseFloat(getComputedStyle(agentScrollbar).opacity) > 0),
          fileTreeConstrained: !needsAgentScroll || Boolean(treeScroller && treeScroller.clientHeight > 0 && treeScroller.scrollHeight >= treeScroller.clientHeight && getComputedStyle(treeScroller).overflowY !== 'visible'),
          fileTreeScrollbarVisible: !needsAgentScroll || Boolean(treeScrollbar && getComputedStyle(treeScrollbar).display !== 'none'),
          fileTreeVisible: !needsAgentScroll || Boolean(treeScroller && treeScroller.getBoundingClientRect().height > 0 && treeScroller.getBoundingClientRect().bottom <= surface.getBoundingClientRect().bottom + 1),
          tabStripConstrained: !needsAgentScroll || Boolean(tabsViewport && tabsViewport.clientWidth > 0 && getComputedStyle(tabsViewport).overflowX === 'auto'),
          tabStripContained: !needsAgentScroll || Boolean(tabsViewport && workspaceCard && tabsViewport.getBoundingClientRect().right <= workspaceCard.getBoundingClientRect().right + 1),
          tabStripScrollable: !needsAgentScroll || Boolean(tabsViewport && (tabsViewport.scrollWidth <= tabsViewport.clientWidth || getComputedStyle(tabsViewport).overflowX === 'auto')),
          tabContentConstrained: !needsAgentScroll || Boolean(tabsContent && tabsContent.clientHeight > 0 && getComputedStyle(tabsContent).overflowY === 'auto'),
        }
      }, { selector: item.selector, needsAgentScroll: item.path === '/teamspace/workspaces' })
      detail.push(`${item.path}: document 无滚动=${!metrics.documentOverflow} | 页面外壳无滚动=${!metrics.surfaceOverflow} | 工作区外层无滚动=${!metrics.workspaceContentOverflow} | Agent 列表内部滚动区=${metrics.agentListConstrained} | Agent 滚动条可见=${metrics.agentScrollbarVisible} | 文件树内部滚动区=${metrics.fileTreeConstrained} | 文件树滚动条可见=${metrics.fileTreeScrollbarVisible} | 文件树未越界=${metrics.fileTreeVisible} | 标签栏可横向滚动且未越界=${metrics.tabStripConstrained && metrics.tabStripScrollable && metrics.tabStripContained} | 标签内容内部滚动=${metrics.tabContentConstrained}`)
      ok &&= !metrics.documentOverflow && !metrics.surfaceOverflow && !metrics.workspaceContentOverflow && metrics.agentListConstrained && metrics.agentScrollbarVisible && metrics.fileTreeConstrained && metrics.fileTreeScrollbarVisible && metrics.fileTreeVisible && metrics.tabStripConstrained && metrics.tabStripScrollable && metrics.tabStripContained && metrics.tabContentConstrained
    } catch (e) { ok = false; detail.push(`${item.path}: 异常:${String(e).slice(0, 120)}`) }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  judge('AS29 Agent 管理与工作区限制在视口内滚动', ok, detail.join(' | '))
}

// The lazy workspace tree must retain expanded nodes across the live status poll.
{
  let ok = true; const detail = []
  try {
    await page.goto(`${teamspaceBase}/teamspace/workspaces`, { waitUntil: 'networkidle', timeout: 20000 })
    const projectRow = page.locator('.sp-workspace-page .el-tree-node__content').filter({ hasText: /^projects$/ }).first()
    await projectRow.waitFor({ timeout: 10000 })
    const projectNode = projectRow.locator('xpath=..')
    const before = await page.locator('.sp-workspace-page .el-tree-node').count()
    if ((await projectNode.getAttribute('aria-expanded')) !== 'true') await projectRow.locator('.el-tree-node__expand-icon').click()
    await page.waitForTimeout(6500)
    const expanded = await projectNode.getAttribute('aria-expanded')
    const after = await page.locator('.sp-workspace-page .el-tree-node').count()
    detail.push(`轮询前后目录数=${before}/${after} | projects 展开状态保持=${expanded === 'true'}`)
    ok &&= expanded === 'true' && after >= before
  } catch (e) { ok = false; detail.push('异常:' + String(e).slice(0, 120)) }
  judge('AS30 工作区文件树在状态轮询后保持展开与稳定', ok, detail.join(' | '))
}

// Workspace status stays above navigation, and processed inbox history has its own view.
{
  let ok = true; const detail = []
  try {
    await page.goto(`${teamspaceBase}/teamspace/workspaces`, { waitUntil: 'networkidle', timeout: 20000 })
    const topStatus = page.locator('.sp-workspace-page .el-alert').first()
    await topStatus.waitFor({ state: 'visible', timeout: 10000 })
    const statusText = await topStatus.innerText()
    const historyTab = page.getByRole('tab', { name: /处理历史/ })
    await historyTab.waitFor({ state: 'visible', timeout: 5000 })
    await historyTab.click()
    const historyView = page.locator('.sp-workspace-page .el-tabs__content')
    await historyView.waitFor({ state: 'visible', timeout: 3000 })
    const historyText = await historyView.innerText()
    const statusVisible = statusText.includes('当前') || statusText.includes('正在')
    const historyVisible = historyText.includes('已处理') || historyText.includes('还没有已完成的历史处理记录')
    detail.push(`工作区顶部显示 Agent 当前状态=${statusVisible} | 历史处理有独立视图=${historyVisible}`)
    ok &&= statusVisible && historyVisible
  } catch (error) { ok = false; detail.push('异常:' + String(error).slice(0, 120)) }
  judge('AS31 工作区显示当前执行状态与历史消化记录', ok, detail.join(' | '))
}

// AS11 A real isolated session verifies the complete DRI decision card lifecycle.
{
  let ok = true; const detail = []
  let eventId = ''
  try {
    const token = await page.evaluate(() => localStorage.getItem('space_token'))
    const db = new DatabaseSync('data/database.db')
    try {
      const user = db.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)
      const agent = db.prepare('SELECT id FROM agent_definitions WHERE id=?').get('a_analyst')
      if (!user?.user_id || !agent?.id) throw new Error('缺少 UI 验收账号或共享 Agent')
      temporaryDecisionSession = `s_ui_decision_${randomUUID().replaceAll('-', '')}`
      eventId = `e_ui_decision_${randomUUID().replaceAll('-', '')}`
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO sessions(id,title,status,created_at,updated_at)
        VALUES (?, 'UI 决策卡片验收', 'open', ?, ?)`).run(temporaryDecisionSession, now, now)
      db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
        VALUES (?, ?, 'DRI', 'active', ?, NULL, ''), (?, 'a_analyst', '成员', 'active', ?, NULL, ''),
          (?, 'a_coordinator', '协调者', 'active', ?, NULL, '')`)
        .run(temporaryDecisionSession, user.user_id, now, temporaryDecisionSession, now, temporaryDecisionSession, now)
      const addEvent = (id, seq, authorId, authorKind, kind, text, replyTo = null) =>
        db.prepare(`INSERT INTO events(id,session_id,seq,phase_id,ts,author_id,author_kind,kind,text,
          mentions,tool_calls,reply_mode,reply_to) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, '[]', '[]', '', ?)`)
          .run(id, temporaryDecisionSession, seq, new Date(Date.now() + seq).toISOString(), authorId,
            authorKind, kind, text, replyTo)
      addEvent(eventId, 1, 'a_analyst', 'agent', 'message',
        '建议采用方案 A。\n\n[测试无效目标按钮](#teamspace-agent?to=unknown_agent&task=执行)\n【需要DRI决策】是否接受方案 A？')
    } finally { db.close() }

    await page.goto(`${teamspaceBase}/teamspace?session=${encodeURIComponent(temporaryDecisionSession)}`,
      { waitUntil: 'networkidle', timeout: 20000 })
    const message = page.locator(`.sp-msg[data-ev-id="${eventId}"]`)
    await message.waitFor({ timeout: 10000 })
    const bubble = await message.locator('.sp-bubble').innerText()
    const pendingCard = message.locator('.el-alert')
    const pendingText = await pendingCard.innerText()
    const pendingVisible = bubble.includes('建议采用方案 A。') && !bubble.includes('【需要DRI决策】') &&
      pendingText.includes('待 DRI 决策') && pendingText.includes('是否接受方案 A？')
    detail.push(`建议正文与待决问题分开展示=${pendingVisible}`)
    ok &&= pendingVisible
    const identityDb = new DatabaseSync('data/database.db')
    const viewerId = identityDb.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)?.user_id
    identityDb.close()
    const membersPanelText = await page.locator('.sp-context-members').innerText()
    const memberSection = page.locator('.sp-context-section').filter({ has: page.locator('.sp-context-members') })
    const memberSectionCount = await memberSection.locator('.sp-context-section-count').innerText()
    const rosterRows = page.locator('.sp-context-members .sp-context-member')
    const rosterCount = await rosterRows.count()
    const coordinatorRow = page.locator('.sp-context-member[title*="不可提及"]')
    const completeRoster = memberSectionCount === '3' && rosterCount === 3 &&
      await coordinatorRow.isDisabled() && membersPanelText.includes('协调者')
    detail.push(`摘要与成员清单都包含不可提及的协调者（3/3）=${completeRoster}`)
    ok &&= completeRoster
    const memberDriNotice = await page.locator('.sp-context-section .el-alert').first().innerText()
    const memberIdentityVisible = Boolean(viewerId) && membersPanelText.includes(viewerId) &&
      memberDriNotice.includes(`当前 DRI：`) && memberDriNotice.includes(viewerId) &&
      memberDriNotice.includes('「通过」') && memberDriNotice.includes('「其他处理」')
    detail.push(`成员面板标明当前 DRI、账号 ID 和卡片操作入口=${memberIdentityVisible}`)
    ok &&= memberIdentityVisible
    const authorName = await message.locator('.sp-msg-name').innerText()
    const namedAgent = authorName === '需求分析师'
    detail.push(`消息作者优先显示共享 Agent 名称=${namedAgent}（${authorName}）`)
    ok &&= namedAgent
    await message.getByRole('link', { name: '测试无效目标按钮' }).click()
    const rejectedAction = await page.getByText('此操作目标不是当前会话中可调用的 Agent').isVisible()
    detail.push(`Agent 操作链接校验会话目标=${rejectedAction}`)
    ok &&= rejectedAction
    await page.screenshot({ path: '/tmp/ui-decision-card.png' })

    await message.getByRole('button', { name: '通过', exact: true }).click()
    const decisionDialog = page.locator('.el-dialog')
    const directActionDialog = await decisionDialog.isVisible() &&
      (await decisionDialog.innerText()).includes('处理 Agent 回复')
    detail.push(`DRI 菜单打开结构化决策窗口=${directActionDialog}`)
    ok &&= directActionDialog
    await decisionDialog.getByText('取消', { exact: true }).click()

    await page.locator('.sp-rail-item.active').getByRole('button', { name: '⋯' }).click()
    await page.getByText('成员 / 角色管理', { exact: true }).click()
    const memberManagementDialog = page.locator('.el-dialog').filter({ hasText: '会话成员管理' })
    const managementText = await memberManagementDialog.innerText()
    const independentAccountsExplained = managementText.includes('作为独立成员加入') &&
      managementText.includes('不会替换或合并') && managementText.includes('成员 ID')
    detail.push(`成员管理解释新邀请账号是独立身份并按 ID 区分=${independentAccountsExplained}`)
    ok &&= independentAccountsExplained
    await memberManagementDialog.getByText('完成', { exact: true }).click()

    const accessDb = new DatabaseSync('data/database.db')
    const currentViewerId = accessDb.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)?.user_id
    try {
      if (!currentViewerId) throw new Error('UI 验收 token 未关联 Team 账号')
      accessDb.prepare(`UPDATE session_members SET role='成员' WHERE session_id=? AND principal_id=?`)
        .run(temporaryDecisionSession, currentViewerId)
      accessDb.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
        VALUES (?, 'u_ui_dri_identity', 'DRI', 'active', ?, NULL, '')`)
        .run(temporaryDecisionSession, new Date().toISOString())
    } finally { accessDb.close() }
    await page.reload({ waitUntil: 'networkidle' })
    const nonDriCard = message.locator('.el-alert')
    const accessNotice = await nonDriCard.innerText()
    const passButtonCount = await message.getByRole('button', { name: '通过', exact: true }).count()
    detail.push(`非 DRI 看到实际 DRI 身份与决策路径=${accessNotice.includes('u_ui_dri_identity') && accessNotice.includes('「通过」')}；隐藏决策按钮=${passButtonCount === 0}`)
    ok &&= accessNotice.includes('u_ui_dri_identity') && accessNotice.includes('「通过」') && passButtonCount === 0
    await message.getByRole('button', { name: '⋯' }).click()
    const nonDriMenuText = await page.locator('.el-dropdown-menu:visible').innerText()
    const nonDriMenuExplained = !nonDriMenuText.includes('通过') && nonDriMenuText.includes('引用')
    detail.push(`非 DRI 操作菜单不含决策项且卡片已解释原因=${nonDriMenuExplained}`)
    ok &&= nonDriMenuExplained
    await page.keyboard.press('Escape')

    const restoreDb = new DatabaseSync('data/database.db')
    try {
      restoreDb.prepare(`UPDATE session_members SET role='DRI' WHERE session_id=? AND principal_id=?`)
        .run(temporaryDecisionSession, currentViewerId)
      restoreDb.prepare(`DELETE FROM session_members WHERE session_id=? AND principal_id='u_ui_dri_identity'`)
        .run(temporaryDecisionSession)
    } finally { restoreDb.close() }
    await page.reload({ waitUntil: 'networkidle' })

    const decisionDb = new DatabaseSync('data/database.db')
    try {
      const addEvent = (id, seq, authorId, authorKind, kind, text, replyTo = null) =>
        decisionDb.prepare(`INSERT INTO events(id,session_id,seq,phase_id,ts,author_id,author_kind,kind,text,
          mentions,tool_calls,reply_mode,reply_to) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, '[]', '[]', '', ?)`)
          .run(id, temporaryDecisionSession, seq, new Date(Date.now() + seq).toISOString(), authorId,
            authorKind, kind, text, replyTo)
      const reviewId = `e_ui_review_${randomUUID().replaceAll('-', '')}`
      addEvent(reviewId, 2, (decisionDb.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)).user_id,
        'human', 'decision', '【撤回复核请求】\n拟决策：pass', eventId)
      await page.reload({ waitUntil: 'networkidle' })
      const reviewing = await message.locator('.el-alert').innerText()
      detail.push(`正在复核状态显示=${reviewing.includes('正在收集复核意见')}`)
      ok &&= reviewing.includes('正在收集复核意见')

      addEvent(`e_ui_review_done_${randomUUID().replaceAll('-', '')}`, 3, null, 'system', 'system',
        '【复核完成】1 个 Agent 提出问题。', reviewId)
      await page.reload({ waitUntil: 'networkidle' })
      const reviewDone = await message.locator('.el-alert').innerText()
      detail.push(`复核完成待定案状态显示=${reviewDone.includes('复核完成，待 DRI 定案')}`)
      ok &&= reviewDone.includes('复核完成，待 DRI 定案')

      addEvent(`e_ui_decision_done_${randomUUID().replaceAll('-', '')}`, 4,
        (decisionDb.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)).user_id,
        'human', 'approval', 'DRI 决策：通过\n目标事件：' + eventId, eventId)
    } finally { decisionDb.close() }
    await page.reload({ waitUntil: 'networkidle' })
    const resolvedText = await message.locator('.el-alert').innerText()
    const resolved = resolvedText.includes('DRI 已通过')
    detail.push(`最终决定状态显示=${resolved}`)
    ok &&= resolved
  } catch (e) {
    ok = false
    detail.push('异常:' + String(e).slice(0, 140))
  } finally {
    const sessionId = temporaryDecisionSession
    const cleaned = cleanTemporaryDecisionSession()
    detail.push(`验收会话及全文索引已清理=${cleaned}`)
    ok &&= cleaned
    if (sessionId) await page.evaluate((id) => {
      localStorage.removeItem(`space_seen_${id}`)
      localStorage.removeItem(`space_draft_${id}`)
    }, sessionId).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
    judge('AS11 Agent 回复卡片可直接发起 DRI 决策', ok, detail.join(' | '))
}

// AS15 group owners can rename a session in the UI and the new title persists.
{
  let ok = true
  const detail = []
  const originalTitle = `UI 重命名 ${randomUUID().slice(0, 8)}`
  const changedTitle = `${originalTitle} 已更新`
  try {
    const token = await page.evaluate(() => localStorage.getItem('space_token'))
    const db = new DatabaseSync('data/database.db')
    const sessionId = `s_ui_rename_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    try {
      const user = db.prepare('SELECT user_id FROM login_tokens WHERE token=?').get(token)
      if (!user?.user_id) throw new Error('UI 验收 token 未关联 Team 账号')
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO sessions(id,title,current_phase,status,created_at,updated_at)
        VALUES (?, ?, NULL, 'open', ?, ?)`).run(sessionId, originalTitle, now, now)
      db.prepare(`INSERT INTO session_members(session_id,principal_id,role,status,joined_at,left_at,duty)
        VALUES (?, ?, '群主', 'active', ?, NULL, 'UI 验收')`).run(sessionId, user.user_id, now)
      temporaryRenameSession = sessionId
    } finally { db.close() }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${teamspaceBase}/teamspace?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle' })
    const row = page.locator('.sp-rail-item').filter({ hasText: originalTitle })
    await row.waitFor({ timeout: 5000 })
    await row.locator('.el-dropdown').click()
    await page.locator('.el-dropdown-menu__item:visible').filter({ hasText: '重命名' }).click()
    const dialog = page.getByRole('dialog', { name: '重命名会话' })
    const titleInput = dialog.getByPlaceholder('输入会话标题')
    await titleInput.fill(changedTitle)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.sp-rail-item').filter({ hasText: changedTitle }).waitFor({ timeout: 5000 })
    await page.locator('.sp-session-title').filter({ hasText: changedTitle }).waitFor({ timeout: 5000 })
    const persisted = new DatabaseSync('data/database.db')
    try {
      const title = persisted.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId)?.title
      ok &&= title === changedTitle
      detail.push(`侧栏标题更新=${title === changedTitle}，聊天页头通过实时推送同步=${await page.locator('.sp-session-title').innerText() === changedTitle}，持久化标题=${title}`)
    } finally { persisted.close() }

    const renamedRow = page.locator('.sp-rail-item').filter({ hasText: changedTitle })
    await renamedRow.locator('.el-dropdown').click()
    await page.locator('.el-dropdown-menu__item:visible').filter({ hasText: '重命名' }).click()
    const retryDialog = page.getByRole('dialog', { name: '重命名会话' })
    const retryInput = retryDialog.getByPlaceholder('输入会话标题')
    await retryInput.fill(`${changedTitle} 网络慢速验收`)
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayRenameFailure', '1'))
    const saveRename = retryDialog.getByRole('button', { name: '保存', exact: true })
    await saveRename.click()
    await page.getByRole('button', { name: '正在保存…', exact: true }).waitFor({ timeout: 1000 })
    const renameInputLocked = await retryInput.isDisabled()
    const renameCancelLocked = await retryDialog.getByRole('button', { name: '取消', exact: true }).isDisabled()
    await retryDialog.getByText(/重命名会话失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
    const renameRetryReady = await retryInput.isEnabled() && await retryInput.inputValue() === `${changedTitle} 网络慢速验收` &&
      await retryDialog.getByRole('button', { name: '保存', exact: true }).isEnabled()
    const renameFailureRetained = new DatabaseSync('data/database.db')
    let unchangedAfterFailure = false
    try { unchangedAfterFailure = renameFailureRetained.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId)?.title === changedTitle }
    finally { renameFailureRetained.close() }
    detail.push(`慢重命名期间锁定输入和取消=${renameInputLocked && renameCancelLocked} | 失败后保留输入并可重试=${renameRetryReady} | 失败未误报持久化=${unchangedAfterFailure}`)
    ok &&= renameInputLocked && renameCancelLocked && renameRetryReady && unchangedAfterFailure
    await retryDialog.getByRole('button', { name: '取消', exact: true }).click()
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    const cleaned = cleanTemporaryRenameSession()
    detail.push(`验收会话已清理=${cleaned}`)
    ok &&= cleaned
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS15 群主可从会话栏重命名并持久化', ok, detail.join(' | '))
}

// AS20 an Agent catalog transport failure must be distinct from a confirmed-empty catalog and retryable.
{
  let ok = true
  const detail = []
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => sessionStorage.setItem('uiVerifyFailAgentBootstrap', '1'))
    await page.goto(`${teamspaceBase}/teamspace/agents`, { waitUntil: 'networkidle' })
    const loading = page.getByText('正在加载 Agent、提示词、工具和模型配置…', { exact: true })
    const loadingVisible = await loading.isVisible().catch(() => false)
    const failed = page.locator('.sp-agent-load-error')
    await failed.waitFor({ timeout: 10000 })
    const failureText = await failed.innerText()
    const explicitFailure = failureText.includes('加载团队 Agent失败')
    const retryVisible = await failed.getByRole('button', { name: '重试加载' }).isVisible()
    const emptyNotMisreported = !(await page.getByText('还没有团队共享 Agent，可以先创建一个', { exact: true }).count())
    detail.push(`断网显示明确加载失败=${explicitFailure}`)
    detail.push(`慢响应期间明确显示加载状态=${loadingVisible}`)
    detail.push(`提供重试入口=${retryVisible}`)
    detail.push(`没有误报成空目录=${emptyNotMisreported}`)
    ok &&= explicitFailure && loadingVisible && retryVisible && emptyNotMisreported
    await page.screenshot({ path: '/tmp/ui-agent-catalog-network-failure.png' })
    await failed.getByRole('button', { name: '重试加载' }).click()
    await page.locator('.sp-agent-load-error').waitFor({ state: 'hidden', timeout: 10000 })
    detail.push('手动重试正常返回并退出错误状态=true')
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyFailAgentBootstrap')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS20 Agent 目录网络故障可辨认并重试恢复', ok, detail.join(' | '))
}

// AS21 the KB page distinguishes a delayed/failed document load from a truly empty library,
// and a search failure from a successful query with no matches.
{
  let ok = true
  const detail = []
  try {
    await page.evaluate(() => sessionStorage.setItem('uiVerifyFailKbBootstrap', '1'))
    await page.goto(`${teamspaceBase}/kb`, { waitUntil: 'networkidle' })
    const loading = page.getByText('正在加载资料…', { exact: true })
    const loadingVisible = await loading.isVisible().catch(() => false)
    const loadError = page.getByText(/加载知识库失败/)
    await loadError.waitFor({ timeout: 10000 })
    const emptyNotMisreported = !(await page.getByText('知识库还没有文档', { exact: true }).count())
    const retry = page.getByRole('button', { name: '重试', exact: true })
    const retryVisible = await retry.isVisible()
    detail.push(`文档慢响应显示加载状态=${loadingVisible}`)
    detail.push(`加载失败不误报为空库=${emptyNotMisreported}`)
    detail.push(`提供明确重试入口=${retryVisible}`)
    ok &&= loadingVisible && emptyNotMisreported && retryVisible
    await page.screenshot({ path: '/tmp/ui-kb-load-failure.png' })
    await retry.click()
    await loadError.waitFor({ state: 'hidden', timeout: 10000 })

    const unnecessaryBackActionRemoved = !(await page.getByRole('button', { name: '← 团队空间', exact: true }).count())
    detail.push(`知识库无用的团队空间回退入口已移除=${unnecessaryBackActionRemoved}`)
    ok &&= unnecessaryBackActionRemoved
    const redundantTopBarRemoved = await page.locator('.sp-kb-wrap').evaluate((element) => {
      const header = document.querySelector('.layout-header')
      return !header || (getComputedStyle(header).display === 'none' && header.getBoundingClientRect().height === 0)
    })
    detail.push(`知识库重复空顶栏已隐藏=${redundantTopBarRemoved}`)
    ok &&= redundantTopBarRemoved

    const columnWidths = await page.evaluate(() => {
      const list = document.querySelector('.sp-kb-document-list-column')
      const detail = document.querySelector('.sp-kb-document-detail-column')
      const root = document.querySelector('.sp-kb-wrap')
      const tabs = document.querySelector('.sp-kb-tabs')
      const tabContent = document.querySelector('.sp-kb-tabs > .el-tabs__content')
      const pane = document.querySelector('.sp-kb-tabs .el-tab-pane')
      const workspace = document.querySelector('.sp-kb-master-detail')
      const listWidth = list?.getBoundingClientRect().width ?? 0
      const detailWidth = detail?.getBoundingClientRect().width ?? 0
      const workspaceRect = workspace?.getBoundingClientRect()
      const describe = (element) => element ? {
        className: String(element.className).slice(0, 70), height: Math.round(element.getBoundingClientRect().height),
        display: getComputedStyle(element).display, flex: getComputedStyle(element).flex,
      } : null
      const ancestors = []
      for (let element = root; element && ancestors.length < 6; element = element.parentElement) ancestors.push(describe(element))
      return {
        listWidth, detailWidth, listToDetail: detailWidth ? listWidth / detailWidth : 0,
        rootWidthRatio: (root?.getBoundingClientRect().width ?? 0) / document.documentElement.clientWidth,
        rootHeight: root?.getBoundingClientRect().height ?? 0,
        tabsHeight: tabs?.getBoundingClientRect().height ?? 0,
        tabContentHeight: tabContent?.getBoundingClientRect().height ?? 0,
        paneHeight: pane?.getBoundingClientRect().height ?? 0,
        ancestors,
        tabsFlex: tabs ? getComputedStyle(tabs).flex : '',
        tabContentFlex: tabContent ? getComputedStyle(tabContent).flex : '',
        paneFlex: pane ? getComputedStyle(pane).flex : '',
        workspaceHeight: workspaceRect?.height ?? 0,
        workspaceBottom: workspaceRect?.bottom ?? 0,
        viewportHeight: document.documentElement.clientHeight,
      }
    })
    const layoutUsesViewport = columnWidths.rootWidthRatio >= 0.72 && columnWidths.rootWidthRatio <= 0.9 && columnWidths.listToDetail >= 0.65 &&
      columnWidths.detailWidth >= 520 && columnWidths.workspaceHeight >= columnWidths.viewportHeight * 0.55 &&
      columnWidths.workspaceBottom >= columnWidths.viewportHeight - 180
    detail.push(`知识库使用宽屏和剩余高度=${layoutUsesViewport}（根宽比 ${columnWidths.rootWidthRatio.toFixed(2)}，根/标签/内容/面板高 ${columnWidths.rootHeight.toFixed(0)}/${columnWidths.tabsHeight.toFixed(0)}/${columnWidths.tabContentHeight.toFixed(0)}/${columnWidths.workspaceHeight.toFixed(0)}px，列表/详情 ${columnWidths.listWidth.toFixed(0)}/${columnWidths.detailWidth.toFixed(0)}px，面板底 ${columnWidths.workspaceBottom.toFixed(0)}px，布局 ${JSON.stringify(columnWidths.ancestors)}，flex ${columnWidths.tabsFlex}/${columnWidths.tabContentFlex}/${columnWidths.paneFlex}）`)
    ok &&= layoutUsesViewport

    const folderTree = page.locator('.sp-kb-folder-scroll .el-tree')
    const folderRoot = folderTree.locator('.el-tree-node__content').filter({ hasText: '全部资料' }).first()
    const explorerFolders = await folderTree.isVisible() && await folderRoot.isVisible() &&
      await page.locator('.sp-kb-folder-scroll .el-menu').count() === 0
    detail.push(`知识库使用可展开的层级文件树=${explorerFolders}`)
    ok &&= explorerFolders

    const openAdd = page.getByRole('button', { name: '添加资料', exact: true })
    await openAdd.click()
    const addDialog = page.locator('.el-dialog:visible').filter({ hasText: '添加团队资料' })
    const addTitle = addDialog.getByPlaceholder('例如：团队产品规范')
    const addText = addDialog.getByPlaceholder('粘贴需要团队共享的文本内容…')
    const addButton = addDialog.getByRole('button', { name: '添加到知识库', exact: true })
    const emptyAddDisabled = await addButton.isDisabled()
    await addTitle.fill('验收草稿标题')
    const partialAddDisabled = await addButton.isDisabled()
    await addText.fill('仅填写标题时不能提交。')
    const completeAddEnabled = !(await addButton.isDisabled())
    detail.push(`新增文档必填状态清楚=${emptyAddDisabled && partialAddDisabled && completeAddEnabled}`)
    ok &&= emptyAddDisabled && partialAddDisabled && completeAddEnabled
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayKbAdd', '1'))
    await addButton.click()
    const addPending = addDialog.getByText('正在建立索引…请保持当前内容，完成前不能关闭此窗口。', { exact: true })
    await addPending.waitFor({ timeout: 1000 })
    const formLocked = await addTitle.isDisabled() && await addText.isDisabled() && await addButton.isDisabled()
    detail.push(`慢提交显示状态并锁定表单=${formLocked}`)
    ok &&= formLocked
    await page.getByText('文档已保存，检索索引正在更新。', { exact: true }).waitFor({ timeout: 5000 })
    await addDialog.waitFor({ state: 'hidden', timeout: 5000 })
    const formResetAfterSuccess = await addDialog.isHidden() && await openAdd.isVisible()
    detail.push(`提交成功后关闭录入窗口并返回资料列表=${formResetAfterSuccess}`)
    ok &&= formResetAfterSuccess

    const documentTab = page.getByRole('tab', { name: '文档管理' })
    const retrievalTab = page.getByRole('tab', { name: '检索验证' })
    const defaultWorkspace = await documentTab.getAttribute('aria-selected') === 'true' &&
      await openAdd.isVisible() && !(await page.getByPlaceholder('搜索知识库…').isVisible())
    detail.push(`默认进入文档管理且检索区分离=${defaultWorkspace}`)
    ok &&= defaultWorkspace
    await retrievalTab.click()
    const searchInput = page.getByPlaceholder('搜索知识库…')
    const retrievalWorkspace = await retrievalTab.getAttribute('aria-selected') === 'true' && await searchInput.isVisible()
    detail.push(`检索验证独立工作区=${retrievalWorkspace}`)
    ok &&= retrievalWorkspace
    await page.evaluate(() => sessionStorage.setItem('uiVerifyEmptyKbSearch', '1'))
    await searchInput.fill('   ')
    const blankSearchEnabled = !(await page.getByRole('button', { name: '搜索', exact: true }).isDisabled())
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const blankSearchError = page.getByText('检索词不能为空，请输入关键词后重试。', { exact: true })
    await blankSearchError.waitFor({ timeout: 5000 })
    const blankSearchRetainsInput = await searchInput.inputValue() === '   '
    const blankSearchNotMisreportedAsNoHits = !(await page.getByText(/没有命中/).count())
    detail.push(`空白检索可提交并显示明确错误=${blankSearchEnabled && blankSearchRetainsInput && blankSearchNotMisreportedAsNoHits}`)
    ok &&= blankSearchEnabled && blankSearchRetainsInput && blankSearchNotMisreportedAsNoHits
    await page.evaluate(() => sessionStorage.setItem('uiVerifySeedKbSearch', '1'))
    await searchInput.fill('旧查询')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByText('旧查询结果', { exact: true }).waitFor({ timeout: 5000 })
    const sourceVisible = await page.getByText('来源：manual', { exact: true }).isVisible()
    detail.push(`检索命中展示来源标记=${sourceVisible}`)
    ok &&= sourceVisible
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayKbSearch', '1'))
    await searchInput.fill('新查询加载中')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const scopedSearchBusy = page.getByText('正在检索「新查询加载中」的相关文档…', { exact: true })
    await scopedSearchBusy.waitFor({ timeout: 1500 })
    const staleResultCleared = !(await page.getByText('旧查询结果', { exact: true }).count())
    detail.push(`慢检索标明当前查询且清除旧结果=${staleResultCleared}`)
    ok &&= staleResultCleared
    await page.getByText(/检索「新查询加载中」命中|没有命中「新查询加载中」/).waitFor({ timeout: 5000 })

    await page.evaluate(() => sessionStorage.setItem('uiVerifyFailKbSearch', '1'))
    await searchInput.fill('慢网络搜索验收')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const searchBusy = page.getByText('正在检索「慢网络搜索验收」的相关文档…', { exact: true })
    const searchBusyVisible = await searchBusy.isVisible().catch(() => false)
    const searchError = page.getByText(/搜索知识库失败/)
    await searchError.waitFor({ timeout: 10000 })
    const failureNotMisreportedAsNoHits = !(await page.getByText('没有命中「慢网络搜索验收」。', { exact: true }).count())
    detail.push(`检索慢响应状态可见=${searchBusyVisible}`)
    detail.push(`检索失败不误报为无命中=${failureNotMisreportedAsNoHits}`)
    ok &&= searchBusyVisible && failureNotMisreportedAsNoHits
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await searchError.waitFor({ state: 'hidden', timeout: 10000 })
    detail.push('用户重新检索后错误状态清除=true')
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => {
      for (const key of ['uiVerifyFailKbBootstrap', 'uiVerifyFailKbSearch', 'uiVerifySeedKbSearch', 'uiVerifyEmptyKbSearch', 'uiVerifyDelayKbSearch', 'uiVerifyDelayKbAdd']) sessionStorage.removeItem(key)
    }).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS21 知识库慢响应、错误反馈与重试状态清晰', ok, detail.join(' | '))
}

// AS22 Agent directory mutations must expose an in-flight state during network latency.
{
  let ok = true
  const detail = []
  try {
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayAgentInvite', '1'))
    await page.goto(`${teamspaceBase}/teamspace/agents`, { waitUntil: 'networkidle' })
    const entry = page.locator('.sp-agent-menu .el-menu-item').filter({ hasText: '需求分析师' }).first()
    await entry.waitFor({ state: 'visible', timeout: 10000 })
    await entry.click()
    await page.locator('.sp-agent-session-select').click()
    await page.locator('.el-popper:visible .el-select-dropdown__item').first().click()
    const invite = page.locator('.sp-agent-form-card').getByRole('button', { name: '邀请入会', exact: true })
    await invite.click()
    await page.waitForTimeout(150)
    const loadingVisible = await invite.evaluate((button) => button.classList.contains('is-loading'))
    const duplicatePrevented = await invite.isDisabled()
    const selectorLocked = await page.locator('.sp-agent-session-select').evaluate((select) => {
      const wrapper = select.querySelector('.el-select__wrapper')
      const combobox = select.querySelector('[role="combobox"]')
      return select.classList.contains('is-disabled') || wrapper?.classList.contains('is-disabled') === true ||
        combobox?.getAttribute('aria-disabled') === 'true' || select.querySelector('input:disabled') !== null
    })
    detail.push(`延迟期间按钮显示进行中=${loadingVisible}`)
    detail.push(`重复提交已禁用=${duplicatePrevented}`)
    detail.push(`目标会话选择保持稳定=${selectorLocked}`)
    ok &&= loadingVisible && duplicatePrevented && selectorLocked
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.sp-agent-form-card button')]
        .find((item) => item.textContent?.includes('邀请入会'))
      return button && !button.classList.contains('is-loading') && !button.disabled
    }, { timeout: 10000 })
    detail.push('响应完成后操作恢复可用=true')
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelayAgentInvite')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS22 Agent 目录邀请操作在慢响应时提供明确状态', ok, detail.join(' | '))
}

// Agent editor values and exit actions stay stable while a save is pending.
{
  let ok = true
  const detail = []
  try {
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayAgentSaveFailure', '1'))
    await page.goto(`${teamspaceBase}/teamspace/agents`, { waitUntil: 'networkidle' })
    const entry = page.locator('.sp-agent-menu .el-menu-item').filter({ hasText: '需求分析师' }).first()
    await entry.waitFor({ state: 'visible', timeout: 10000 })
    await entry.click()
    const description = page.locator('.sp-agent-form-content textarea').first()
    await description.fill('慢速保存验收：内容需要保留')
    const save = page.locator('.sp-agent-form-card').getByRole('button', { name: '保存更改', exact: true })
    await save.click()
    await page.waitForTimeout(150)
    const pendingVisible = await save.evaluate((button) => button.classList.contains('is-loading'))
    const controlsLocked = await page.locator('.sp-agent-form-content input, .sp-agent-form-content textarea').evaluateAll((controls) =>
      controls.length > 0 && controls.every((control) => control.disabled))
    const cancelLocked = await page.locator('.sp-agent-form-card').getByRole('button', { name: '撤销修改', exact: true }).isDisabled()
    detail.push(`保存期间状态可见=${pendingVisible}`)
    detail.push(`编辑控件和取消操作锁定=${controlsLocked && cancelLocked}`)
    ok &&= pendingVisible && controlsLocked && cancelLocked
    await page.getByText(/保存 Agent 配置失败，请检查网络后重试/u).waitFor({ timeout: 5000 })
    const inputRetained = await description.inputValue() === '慢速保存验收：内容需要保留'
    const controlsRestored = await description.isEnabled() && await page.locator('.sp-agent-form-card').getByRole('button', { name: '撤销修改', exact: true }).isEnabled()
    detail.push(`失败后保留编辑内容=${inputRetained}`)
    detail.push(`失败后恢复编辑=${controlsRestored}`)
    ok &&= inputRetained && controlsRestored
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelayAgentSaveFailure')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS27 Agent 配置在慢保存时锁定编辑，失败保留输入并可重试', ok, detail.join(' | '))
}

// AS23 Session member invites remain explicit and prevent duplicate submission
// while the server is slow; errors have a place inside the dialog.
{
  let ok = true
  const detail = []
  try {
    const activeSession = page.locator('.sp-rail-item.active')
    await activeSession.waitFor({ state: 'visible', timeout: 5000 })
    await activeSession.locator('.el-dropdown').click()
    await page.locator('.el-dropdown-menu__item:visible').filter({ hasText: '邀请' }).click()
    const dialog = page.getByRole('dialog', { name: '邀请成员加入会议' })
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await dialog.locator('.el-select').click()
    await page.locator('.el-popper:visible .el-select-dropdown__item').first().click()
    await dialog.locator('.el-select input').press('Escape')
    const confirm = dialog.getByRole('button', { name: '确定', exact: true })
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelaySessionInvite', '1'))
    await confirm.click()
    await page.waitForTimeout(150)
    const loading = await confirm.evaluate((button) => button.classList.contains('is-loading'))
    const duplicatePrevented = await confirm.isDisabled()
    const selectionLocked = await dialog.locator('.el-select').evaluate((select) => {
      const wrapper = select.querySelector('.el-select__wrapper')
      const combobox = select.querySelector('[role="combobox"]')
      return select.classList.contains('is-disabled') || wrapper?.classList.contains('is-disabled') === true ||
        combobox?.getAttribute('aria-disabled') === 'true' || select.querySelector('input:disabled') !== null
    })
    detail.push(`慢邀请显示进行中=${loading}`)
    detail.push(`防止重复提交=${duplicatePrevented}`)
    detail.push(`邀请对象在提交期间锁定=${selectionLocked}`)
    ok &&= loading && duplicatePrevented && selectionLocked
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })
    detail.push('成功反馈后关闭对话框=true')
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelaySessionInvite')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS23 会话邀请在慢响应时可见进度并避免重复提交', ok, detail.join(' | '))
}

// AS24 Opening member management shows a loading state instead of a false empty list.
{
  let ok = true
  const detail = []
  try {
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayMemberList', '1'))
    const activeSession = page.locator('.sp-rail-item.active')
    await activeSession.waitFor({ state: 'visible', timeout: 5000 })
    await activeSession.locator('.el-dropdown').click()
    await page.locator('.el-dropdown-menu__item:visible').filter({ hasText: '移除成员' }).click()
    const dialog = page.getByRole('dialog', { name: '会话成员管理' })
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    const emptyState = dialog.locator('.el-table__empty-text')
    await emptyState.waitFor({ state: 'visible', timeout: 3000 })
    const loadingMessage = await emptyState.innerText()
    const explicitLoading = loadingMessage.includes('正在加载成员') && !loadingMessage.includes('暂无成员')
    detail.push(`成员列表慢响应明确显示加载中=${explicitLoading}`)
    await page.screenshot({ path: '/tmp/ui-session-members-loading.png' })
    await dialog.locator('.el-table__body tr').first().waitFor({ state: 'visible', timeout: 5000 })
    detail.push('读取完成后成员列表出现=true')
    ok &&= explicitLoading
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelayMemberList')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS24 会话成员慢加载不再伪装成空成员列表', ok, detail.join(' | '))
}

// AS25 Group creation keeps slow failures actionable inside the still-open dialog.
{
  let ok = true
  const detail = []
  try {
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' })
    const createButton = page.locator('.page-sidebar-header').getByRole('button', { name: '新会议' })
    await createButton.waitFor({ state: 'visible', timeout: 5000 })
    await createButton.click()
    const dialog = page.getByRole('dialog', { name: '创建新会议' })
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await page.evaluate(() => sessionStorage.setItem('uiVerifyDelayGroupCreateFailure', '1'))
    const confirm = dialog.getByRole('button', { name: '创建会议', exact: true })
    await confirm.click()
    const progressButton = dialog.getByRole('button', { name: '正在创建…', exact: true })
    await progressButton.waitFor({ state: 'visible', timeout: 1000 })
    const loading = await progressButton.evaluate((button) => button.classList.contains('is-loading'))
    const duplicatePrevented = await progressButton.isDisabled()
    const progressLabel = await progressButton.count() === 1
    const formLocked = await dialog.locator('input').first().isDisabled() &&
      await dialog.locator('.el-select').evaluateAll((selects) => selects.length > 0 && selects.every((select) => {
        const wrapper = select.querySelector('.el-select__wrapper')
        const combobox = select.querySelector('[role="combobox"]')
        return select.classList.contains('is-disabled') || wrapper?.classList.contains('is-disabled') ||
          combobox?.getAttribute('aria-disabled') === 'true' || Boolean(select.querySelector('input:disabled'))
      }))
    const closeLocked = await dialog.locator('.el-dialog__headerbtn').count() === 0
    const cancelLocked = await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled()
    await dialog.locator('.el-alert').waitFor({ state: 'visible', timeout: 5000 })
    const failureText = await dialog.locator('.el-alert').innerText()
    const errorVisibleInDialog = failureText.includes('新建会话失败') && failureText.includes('检查网络后重试')
    const dialogStayedOpen = await dialog.isVisible()
    detail.push(`慢创建显示进行中=${loading} | 防止重复提交=${duplicatePrevented} | 请求期间表单/关闭操作锁定=${formLocked && closeLocked && cancelLocked} | 失败提示留在对话框内=${errorVisibleInDialog} | 对话框保留可重试状态=${dialogStayedOpen}`)
    ok &&= loading && duplicatePrevented && progressLabel && formLocked && closeLocked && cancelLocked && errorVisibleInDialog && dialogStayedOpen
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelayGroupCreateFailure')).catch(() => {})
    await page.evaluate(() => sessionStorage.removeItem('uiVerifyDelayRenameFailure')).catch(() => {})
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' }).catch(() => {})
  }
  judge('AS25 新建会话慢请求失败在对话框内可见且可重试', ok, detail.join(' | '))
}

{
  let safePause = false
  try {
    await page.evaluate(() => sessionStorage.setItem('uiVerifyUnknownPause', '1'))
    await page.goto(`${teamspaceBase}/teamspace?session=s_seed_demo`, { waitUntil: 'networkidle' })
    await page.getByText('处理已安全暂停，请联系系统管理员。', { exact: true }).waitFor({ timeout: 10000 })
    safePause = !(await page.locator('body').innerText()).includes('private_internal_reason')
  } finally { await page.evaluate(() => sessionStorage.removeItem('uiVerifyUnknownPause')).catch(() => {}) }
  judge('AS26 未知内部暂停原因采用安全提示且不泄漏原始reason', safePause, '真实页面消费turn RPC夹具；不匹配组件源码表达式')
}

console.log('页面错误:', errs.length ? errs : '（无）')
await page.screenshot({ path: '/tmp/ui-final.png' })
await browser.close()
const memberCleanupOk = cleanTemporaryDemoMember()
process.removeListener('exit', cleanTemporaryDemoMember)
judge('AS10 UI 验收账号退出 seed 演示会话', memberCleanupOk, memberCleanupOk
  ? '验收账号已标记离会' : '验收账号仍是活动成员或清理失败')

// AS26 Authentication fields have persistent labels, password-manager hints and a usable narrow layout.
{
  let ok = true
  const detail = []
  let authBrowser
  let authContext
  try {
    authBrowser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {})
    authContext = await authBrowser.newContext({ viewport: { width: 390, height: 844 } })
    const authPage = await authContext.newPage()
    const authErrors = []
    authPage.on('pageerror', (error) => authErrors.push(String(error).slice(0, 120)))
    await authPage.goto(`${teamspaceBase}/login`, { waitUntil: 'networkidle', timeout: 20000 })
    await authPage.locator('.sp-auth-card').waitFor({ timeout: 5000 })
    const loginLabels = await authPage.locator('label[for="login-username"], label[for="login-password"]').count() === 2
    const loginAutocomplete = await authPage.locator('#login-username').getAttribute('autocomplete') === 'username' &&
      await authPage.locator('#login-password').getAttribute('autocomplete') === 'current-password'
    await authPage.getByRole('tab', { name: '注册' }).click()
    const registerLabels = await authPage.locator('label[for="register-username"], label[for="register-password"], label[for="register-display-name"]').count() === 3
    const registerAutocomplete = await authPage.locator('#register-username').getAttribute('autocomplete') === 'username' &&
      await authPage.locator('#register-password').getAttribute('autocomplete') === 'new-password' &&
      await authPage.locator('#register-display-name').getAttribute('autocomplete') === 'nickname'
    const width = await authPage.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    const mobileFit = width.document <= width.viewport
    detail.push(`登录字段关联可见标签=${loginLabels} | 自动填充语义=${loginAutocomplete}`)
    detail.push(`注册字段关联可见标签=${registerLabels} | 自动填充语义=${registerAutocomplete} | 窄屏无横向溢出=${mobileFit}（${width.document}/${width.viewport}px）`)
    ok &&= loginLabels && loginAutocomplete && registerLabels && registerAutocomplete && mobileFit && authErrors.length === 0
    await authPage.screenshot({ path: '/tmp/ui-auth-mobile.png' })
  } catch (error) {
    ok = false
    detail.push(`异常=${String(error).slice(0, 160)}`)
  } finally {
    await authContext?.close()
    await authBrowser?.close()
  }
  judge('AS26 登录与注册表单标签及自动填充可用', ok, detail.join(' | '))
}

console.log(`断言汇总: ${reds.length ? 'RED → ' + reds.join(', ') : '全部 GREEN'}`)
process.exitCode = reds.length ? 1 : 0
