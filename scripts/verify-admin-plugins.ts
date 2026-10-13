// Open Admin plugin operations need no Team token and never return secret values.
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
  emit: () => undefined,
  webui: { addEntry: (_entry: unknown, exposed: Record<string, (...args: any[]) => Promise<any>>) => { rpc = exposed } },
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
assert.ok(Array.isArray(await rpc.plugins('')), 'admin inventory is available without a login token')
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
assert.deepEqual(await rpc.sandboxApprovals(''), [approval], 'approval queue is available without a login token')
assert.deepEqual(await rpc.sandboxApprovals('admin-session'), [approval])
const decisionResult = await rpc.decideSandboxApproval('', 'sar_test', 'approved', 'reviewed')
assert.equal(decisionResult.ok, true)
assert.equal(delivered, true, 'approval copies only through the trusted delivery service')
assert.equal(decision, 'approved:admin-open:reviewed:approvals/sar_test/input.txt')
assert.equal((await rpc.saveTextProfile('', { id: 'ark-code', name: 'Open admin', baseURL: 'https://provider.invalid/v1', model: 'model', apiKey: 'profile-secret' })).ok, true, 'writes are available without a login token')
assert.equal((await rpc.saveTextProfile('admin-session', {
  id: 'bad-limit', name: 'Invalid cap', baseURL: 'https://provider.invalid/v1', model: 'model', maxOutputTokens: 0,
})).error, 'invalid_input', 'output token caps must be positive integers')
const savedProfile = await rpc.saveTextProfile('admin-session', {
  id: 'ark-code', name: 'Ark Coding', baseURL: 'https://provider.invalid/v1', model: 'coding-model', apiKey: 'profile-secret', maxOutputTokens: 4096,
})
assert.equal(savedProfile.ok, true)
const apiConfig = await rpc.getApiConfig('admin-session')
assert.deepEqual(apiConfig.textProfiles[0], {
  id: 'ark-code', name: 'Ark Coding', baseURL: 'https://provider.invalid/v1', model: 'coding-model',
  maxOutputTokens: 4096, hasKey: true, keyTail: 'cret',
})
assert.equal(JSON.stringify(apiConfig).includes('profile-secret'), false, 'profile credentials are never returned by admin config')
assert.equal((await rpc.testTextProfile('admin-session', 'ark-code')).ok, true)
assert.equal(testedProfile, 'ark-code')
assert.equal((await rpc.testTextProfileStream('', 'ark-code')).ok, true, 'model operations are available without a login token')
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
assert.equal(settingValues.has('llm.profile.ark-code.maxOutputTokens'), false, 'removing a profile clears its output cap')
for (const kind of ['embedding', 'webSearch'] as const) {
  const prefix = kind === 'embedding' ? 'embed' : 'search'
  settingValues.set(`${prefix}.baseURL`, 'https://original.invalid/v1')
  settingValues.set(`${prefix}.apiKey`, 'original-service-key')
  if (kind === 'embedding') settingValues.set('embed.model', 'original-embedding')
  assert.equal((await rpc.saveServiceProfile('', kind, {
    id: 'alternative', name: 'Alternative', baseURL: 'https://alternative.invalid/v1',
    model: 'alternative-embedding', apiKey: 'alternative-service-key',
  })).ok, true, `${kind} supports adding a provider`)
  let config = await rpc.getApiConfig('')
  assert.equal(config[kind === 'embedding' ? 'embeddingProfiles' : 'webSearchProfiles'][0].id, 'alternative')
  assert.ok(!JSON.stringify(config).includes('alternative-service-key'), 'provider credentials never appear in config responses')
  assert.equal((await rpc.activateServiceProfile('', kind, 'alternative')).ok, true)
  assert.equal(settingValues.get(`${prefix}.baseURL`), 'https://alternative.invalid/v1', 'activation reaches the runtime configuration')
  assert.equal(settingValues.get(`${prefix}.apiKey`), 'alternative-service-key')
  assert.equal((await rpc.activateServiceProfile('', kind, 'default')).ok, true)
  assert.equal(settingValues.get(`${prefix}.apiKey`), 'original-service-key', 'switching back preserves the original provider')
  await (kind === 'embedding' ? rpc.saveEmbeddingApi('', { apiKey: 'updated-default-key' }) : rpc.saveWebSearchApi('', { apiKey: 'updated-default-key' }))
  await rpc.activateServiceProfile('', kind, 'alternative')
  await rpc.saveServiceProfile('', kind, { id: 'alternative', name: 'Alternative edited', baseURL: 'https://edited.invalid/v1', model: 'edited-embedding', apiKey: '' })
  assert.equal(settingValues.get(`${prefix}.baseURL`), 'https://edited.invalid/v1', 'editing the active provider updates the live configuration')
  assert.equal(settingValues.get(`${prefix}.apiKey`), 'alternative-service-key', 'an empty key retains this provider\'s stored key')
  assert.equal((await rpc.removeServiceProfile('', kind, 'alternative')).ok, true)
  assert.equal(settingValues.get(`${prefix}.apiKey`), 'updated-default-key', 'deleting the active provider restores the latest default configuration')
  assert.equal(settingValues.has(`${prefix}.profile.alternative.apiKey`), false, 'deletion clears the removed provider\'s secret')
}
let modelRequest: { url: URL; init?: RequestInit } | undefined
let modelResponseStatus = 200
let modelResponseBody: unknown = { data: [{ id: 'doubao-seed-2-pro' }, { id: 'ark-code-latest' }] }
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  modelRequest = { url: new URL(input instanceof Request ? input.url : input.toString()), init }
  return new Response(JSON.stringify(modelResponseBody), {
    status: modelResponseStatus, headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch
try {
  const catalog = await rpc.fetchTextModels('', {
    target: 'text', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', apiKey: 'coding-plan-api-key',
  })
  assert.deepEqual(catalog.models, ['ark-code-latest', 'doubao-seed-2-pro'])
  assert.equal(catalog.credentialSource, '输入框中的未保存密钥')
  assert.equal(modelRequest?.url.hostname, 'ark.cn-beijing.volces.com')
  assert.equal(modelRequest?.url.pathname, '/api/coding/v3/models', 'Ark Coding Plan uses the generic OpenAI-compatible /models path')
  assert.equal(modelRequest?.init?.method, undefined, 'model listing is a GET request')
  assert.equal((modelRequest?.init?.headers as Record<string, string>).Authorization, 'Bearer coding-plan-api-key')
  assert.equal(JSON.stringify(catalog).includes('coding-plan-api-key'), false, 'model-list response never contains credentials')
  modelResponseBody = { data: [
    { id: 'doubao-seed-2-pro', type: 'chat' },
    { id: 'qwen3.7-text-embedding' },
    { id: 'ark-embed-v1', capabilities: ['embeddings'] },
  ] }
  const embedding = await rpc.fetchTextModels('', { target: 'embedding', baseURL: 'https://provider.invalid/v1', apiKey: 'embed-key' })
  assert.deepEqual(embedding.models, ['ark-embed-v1', 'qwen3.7-text-embedding'], 'Embedding discovery excludes chat models and recognizes metadata and common model IDs')
  assert.equal(embedding.credentialSource, '输入框中的未保存密钥')
  assert.equal(modelRequest?.url.pathname, '/v1/models')
  assert.equal((modelRequest?.init?.headers as Record<string, string>).Authorization, 'Bearer embed-key')
  settingValues.set('embed.profile.catalog-a.apiKey', 'catalog-a-key')
  settingValues.set('embed.profile.catalog-b.apiKey', 'catalog-b-key')
  for (const profileId of ['catalog-a', 'catalog-b']) {
    const scoped = await rpc.fetchTextModels('', { target: 'embeddingProfile', profileId, baseURL: 'https://provider.invalid/v1', apiKey: '' })
    assert.equal(scoped.ok, true)
    assert.equal((modelRequest?.init?.headers as Record<string, string>).Authorization, `Bearer ${profileId}-key`, 'Embedding model discovery uses the selected provider\'s saved key')
  }
  const unsaved = await rpc.fetchTextModels('', { target: 'embeddingProfile', profileId: '', baseURL: 'https://provider.invalid/v1', apiKey: '' })
  assert.equal(unsaved.ok, false, 'an unsaved provider cannot borrow the default provider\'s key')
  modelResponseBody = { data: [{ id: 'doubao-seed-2-pro', type: 'chat' }] }
  const noEmbedding = await rpc.fetchTextModels('', { target: 'embedding', baseURL: 'https://provider.invalid/v1', apiKey: 'embed-key' })
  assert.equal(noEmbedding.ok, false, 'Embedding discovery never presents text-only results as embedding models')
  assert.match(noEmbedding.detail, /未识别到 Embedding 模型/u)
  modelResponseBody = { data: [{ id: 'doubao-seed-2-pro' }, { id: 'ark-code-latest' }] }
  const profile = await rpc.fetchTextModels('', { target: 'profile', profileId: 'custom', baseURL: 'https://provider.invalid/openai/v1/', apiKey: 'profile-key' })
  assert.equal(profile.ok, true, 'text profiles use generic provider model discovery')
  assert.equal(profile.credentialSource, '输入框中的未保存密钥')
  assert.equal(modelRequest?.url.pathname, '/openai/v1/models', 'model discovery preserves a nested OpenAI-compatible Base URL')
  settingValues.set('llm.apiKey', 'saved-key')
  modelResponseStatus = 401
  const rejectedDraft = await rpc.fetchTextModels('', { target: 'text', baseURL: 'https://provider.invalid/v1', apiKey: 'autofilled-account-password' })
  assert.equal(rejectedDraft.credentialSource, '输入框中的未保存密钥')
  assert.match(rejectedDraft.detail, /输入框中的未保存密钥/u)
  assert.equal(JSON.stringify(rejectedDraft).includes('autofilled-account-password'), false, '401 diagnostics describe key origin without exposing key values')
  const rejectedSaved = await rpc.fetchTextModels('', { target: 'text', baseURL: 'https://provider.invalid/v1', apiKey: '' })
  assert.equal(rejectedSaved.credentialSource, '已保存密钥（输入框留空）')
  assert.match(rejectedSaved.detail, /已保存密钥（输入框留空）/u)
} finally {
  globalThis.fetch = originalFetch
}
console.log('✓ Open Admin operations and generic OpenAI-compatible model discovery for text, embedding, profiles, and Ark Coding Plan are covered')
execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-admin-plugins', '{"ok":true}'], { stdio: 'inherit' })
