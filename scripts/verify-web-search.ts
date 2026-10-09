import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import { ToolRegistry } from '../plugins/space-tool/index.ts'
import { apply } from '../plugins/tool-web-search/index.ts'

const ctx = new Context()
const settings = new Map<string, string>([
  ['search.baseURL', 'https://search.example/api/'], ['search.apiKey', 'test-secret'],
])
const tools = new ToolRegistry(ctx, { allow: ['web.search'] })
Object.assign(ctx, { settings: { get: (key: string, fallback = '') => settings.get(key) ?? fallback } })
apply(ctx)
const originalFetch = globalThis.fetch
let request: { url: string; init?: RequestInit } | undefined
globalThis.fetch = (async (url, init) => {
  request = { url: String(url), init }
  return Response.json({ results: [
    { title: 'Result', url: 'https://example.com', content: 'Useful summary' },
    { title: 'Extra', url: 'https://extra.example', snippet: 'Should be capped' },
  ] })
}) as typeof fetch

try {
  const result = await tools.invoke('web.search', JSON.stringify({ query: 'Cordis', max_results: 1 }), { id: 'a_test' })
  assert.equal(result.ok, true)
  assert.match(result.output, /Useful summary/)
  assert.doesNotMatch(result.output, /Should be capped/)
  assert.equal(request?.url, 'https://search.example/api/search')
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer test-secret')
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { query: 'Cordis', max_results: 1 })
  assert.doesNotMatch(JSON.stringify(result), /test-secret/)

  settings.delete('search.apiKey')
  const unconfigured = await tools.invoke('web.search', JSON.stringify({ query: 'Cordis' }), { id: 'a_test' })
  assert.equal(unconfigured.ok, false)
  assert.match(unconfigured.output, /尚未配置/)
  const malformed = await tools.invoke('web.search', '{', { id: 'a_test' })
  assert.equal(malformed.ok, false)
  console.log('✓ web.search uses configured credentials, caps results, handles invalid input, and redacts secrets')
  execFileSync(process.execPath, ['scripts/record-action.mjs', 'verify-web-search', '{"ok":true}'], { stdio: 'inherit' })
} finally {
  globalThis.fetch = originalFetch
}
