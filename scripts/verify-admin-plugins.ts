// Admin plugin inventory is authenticated, read-only, and never returns secret values.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { Context } from 'cordis'
import { apply } from '../packages/client-ui/space-client-ui-admin/src/index.ts'

let rpc: Record<string, (...args: any[]) => Promise<any>> | undefined
const entries = [
  { options: { id: 'active-plugin', name: './plugins/active.ts', config: { enabled: true, apiKey: 'secret-value', nested: { password: 'hidden' } } }, disabled: false, fiber: { state: 2 } },
  { options: { id: 'disabled-plugin', name: './plugins/off.ts', config: { mode: 'off' } }, disabled: true, fiber: undefined },
  { options: { id: 'failed-plugin', name: './plugins/missing.ts', config: {} }, disabled: false, fiber: undefined },
]
const approval = { id: 'sar_test', agentId: 'agent-x', sessionId: 'session-y', sourcePath: '/tmp/input.txt', sourceSize: 3, sourceMtimeMs: 1, sourceCtimeMs: 1, sourceInode: 1, reason: 'fixture', status: 'pending', createdAt: '2026-10-09T00:00:00.000Z', decidedAt: null, decidedBy: null, decisionNote: '', deliveryPath: null }
let decision: string | undefined
let delivered = false
const settingValues = new Map<string, unknown>()
let testedProfile = ''
let streamedProfile = ''
let failStreamTest = false
let agentProfileRefs: Array<{ llmProfileRef: string }> = []
const ctx = {
  webui: { addEntry: (_entry: unknown, exposed: Record<string, (...args: any[]) => Promise<any>>) => { rpc = exposed } },
  adminAuth: { verifyToken: async (token: string) => {
    if (token !== 'admin-session') throw new Error('unauthorized')
    return { id: 'admin-root', username: 'admin' }
  } },
  loader: { *entries() { yield* entries } },
  sandboxApproval: {
    list: () => [approval], get: () => approval,
    beginApproval: (_id: string, adminId: string, note: string) => ({ ...approval, status: 'approving', decidedBy: adminId, decisionNote: note }),
    decide: (_id: string, value: string, adminId: string, note: string, path?: string) => {
      decision = `${value}:${adminId}:${note}:${path ?? ''}`
      return { ...approval, status: value, decidedBy: adminId, decisionNote: note, deliveryPath: path ?? null }
    },
  },
  sandboxApprovalDelivery: { deliver: async () => { delivered = true; return { relativePath: 'approvals/sar_test/input.txt' } } },
  settings: {
    get: (key: string, fallback: unknown) => settingValues.has(key) ? settingValues.get(key) : fallback,
    set: (key: string, value: unknown) => { if (value === undefined) settingValues.delete(key); else settingValues.set(key, value) },
  },
  llm: {
    configured: true,
    chat: async (_messages: unknown, options?: { profileRef?: string; onToken?: (delta: string) => void }) => {
      if (options?.onToken) {
        streamedProfile = options.profileRef ?? ''
        if (failStreamTest) {
          options.onToken('部分')
          throw new Error('mock stream timeout')
        }
        options.onToken('流式')
        options.onToken('测试成功')
        return '流式测试成功'
      }
      testedProfile = options?.profileRef ?? ''
      return 'pong'
    },
  },
  embeddings: { configured: true },
  agentCatalog: { list: () => agentProfileRefs },
  logger: { info: () => undefined },
} as unknown as Context

apply(ctx)
assert.ok(rpc)
assert.equal(await rpc.plugins('invalid-session'), null, 'Team/invalid token cannot read admin-only plugin inventory')
const before = JSON.stringify(entries)
const rows = await rpc.plugins('admin-session') as Array<{ id: string; name: string; status: string; config: Record<string, any> }>
assert.deepEqual(rows.map((row) => row.id), ['active-plugin', 'disabled-plugin', 'failed-plugin'])
assert.equal(rows[0].status, '运行中')
assert.equal(rows[1].status, '配置停用')
assert.equal(rows[2].status, '未加载')
assert.equal(rows[0].config.apiKey, '已配置（已隐藏）')
assert.equal(rows[0].config.nested.password, '已配置（已隐藏）')
assert.equal(JSON.stringify(rows).includes('secret-value'), false)
assert.equal(JSON.stringify(entries), before, 'inventory endpoint must not mutate loader configuration')
assert.equal(await rpc.sandboxApprovals('invalid-session'), null, 'approval queue is Admin-only')
assert.deepEqual(await rpc.sandboxApprovals('admin-session'), [approval])
assert.equal(await rpc.decideSandboxApproval('invalid-session', 'sar_test', 'approved'), null, 'unauthenticated requests cannot decide approvals')
const decisionResult = await rpc.decideSandboxApproval('admin-session', 'sar_test', 'approved', 'reviewed')
assert.equal(decisionResult.ok, true)
assert.equal(delivered, true, 'approval copies only through the trusted delivery service')
assert.equal(decision, 'approved:admin-root:reviewed:approvals/sar_test/input.txt')
assert.equal(await rpc.saveTextProfile('invalid-session', { id: 'ark-code', name: 'Ark', baseURL: 'https://provider.invalid/v1', model: 'model', apiKey: 'profile-secret' }), null)
const savedProfile = await rpc.saveTextProfile('admin-session', {
  id: 'ark-code', name: 'Ark Coding', baseURL: 'https://provider.invalid/v1', model: 'coding-model', apiKey: 'profile-secret',
})
assert.equal(savedProfile.ok, true)
const apiConfig = await rpc.getApiConfig('admin-session')
assert.deepEqual(apiConfig.textProfiles[0], {
  id: 'ark-code', name: 'Ark Coding', baseURL: 'https://provider.invalid/v1', model: 'coding-model',
  hasKey: true, keyTail: 'cret',
})
assert.equal(JSON.stringify(apiConfig).includes('profile-secret'), false, 'profile credentials are never returned by admin config')
assert.equal((await rpc.testTextProfile('admin-session', 'ark-code')).ok, true)
assert.equal(testedProfile, 'ark-code')
assert.equal(await rpc.testTextProfileStream('invalid-session', 'ark-code'), null)
const streamResult = await rpc.testTextProfileStream('admin-session', 'ark-code')
assert.equal(streamResult.ok, true)
assert.match(streamResult.detail, /2 段/u)
assert.match(streamResult.detail, /6 字符/u)
assert.equal(streamedProfile, 'ark-code')
failStreamTest = true
const interruptedStreamResult = await rpc.testTextProfileStream('admin-session', 'ark-code')
assert.equal(interruptedStreamResult.ok, false)
assert.match(interruptedStreamResult.detail, /mock stream timeout/u)
assert.match(interruptedStreamResult.detail, /1 段，2 字符/u, 'failed stream tests retain partial output metrics')
failStreamTest = false
assert.equal((await rpc.setDefaultTextProfile('admin-session', 'ark-code')).ok, true)
assert.equal((await rpc.getApiConfig('admin-session')).activeTextProfileRef, 'ark-code')
agentProfileRefs = [{ llmProfileRef: 'ark-code' }]
assert.equal((await rpc.removeTextProfile('admin-session', 'ark-code')).error, 'in_use', 'referenced profiles cannot be removed')
agentProfileRefs = []
assert.equal((await rpc.removeTextProfile('admin-session', 'ark-code')).ok, true)
assert.equal((await rpc.getApiConfig('admin-session')).activeTextProfileRef, '')
assert.equal(settingValues.has('llm.profile.ark-code.apiKey'), false, 'removing a profile clears its secret')
console.log('✓ Admin plugin inventory, sandbox approvals, and multi-provider API profiles enforce auth and redact credentials')
execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-admin-plugins', '{"ok":true}'], { stdio: 'inherit' })
