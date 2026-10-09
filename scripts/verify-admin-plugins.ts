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
const ctx = {
  webui: { addEntry: (_entry: unknown, exposed: Record<string, (...args: any[]) => Promise<any>>) => { rpc = exposed } },
  adminAuth: { verifyToken: async (token: string) => {
    if (token !== 'admin-session') throw new Error('unauthorized')
    return { id: 'admin-root', username: 'admin' }
  } },
  loader: { *entries() { yield* entries } },
  sandboxApproval: {
    list: () => [approval], get: () => approval,
    decide: (_id: string, value: string, adminId: string, note: string, path?: string) => {
      decision = `${value}:${adminId}:${note}:${path ?? ''}`
      return { ...approval, status: value, decidedBy: adminId, decisionNote: note, deliveryPath: path ?? null }
    },
  },
  sandboxApprovalDelivery: { deliver: async () => { delivered = true; return { relativePath: 'approvals/sar_test/input.txt' } } },
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
console.log('✓ Admin plugin inventory and sandbox approvals are authenticated; inventory is read-only and secrets are redacted')
execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-admin-plugins', '{"ok":true}'], { stdio: 'inherit' })
