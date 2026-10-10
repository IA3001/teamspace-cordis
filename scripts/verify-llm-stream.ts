import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { OpenAiChatLlm } from '../packages/impl/space-llm-openai/src/index.ts'
import { runAgentExecutionGraph } from '../packages/impl/space-agent-runtime/src/execution-graph.ts'

const originalFetch = globalThis.fetch
let sentBody: Record<string, unknown> | undefined
let sentUrl = ''
let sentAuthorization = ''
let jsonResponse = false
const deltas: string[] = []
globalThis.fetch = (async (url, init) => {
  sentUrl = String(url)
  sentAuthorization = new Headers(init?.headers).get('authorization') ?? ''
  sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
  if (jsonResponse) return Response.json({ choices: [{ message: { content: 'profile reply' } }] })
  const encoder = new TextEncoder()
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，团队"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}) as typeof fetch

try {
  const llm = new OpenAiChatLlm(new Context(), {
    apiKey: 'stream-test-key', baseURL: 'https://llm.example/v1', model: 'stream-test-model',
  })
  const answer = await llm.chat([{ role: 'user', content: 'hello' }], { onToken: (delta) => deltas.push(delta) })
  assert.equal(sentBody?.stream, true)
  assert.equal(answer, '你好，团队')
  assert.deepEqual(deltas, ['你好', '，团队'])
  assert.doesNotMatch(JSON.stringify({ answer, deltas }), /stream-test-key/)

  const profileSettings = {
    get(key: string, fallback: unknown) {
      const values: Record<string, unknown> = {
        'llm.profiles': [{ id: 'provider-b' }],
        'llm.activeProfileRef': 'provider-b',
        'llm.profile.provider-b.apiKey': 'profile-secret',
        'llm.profile.provider-b.baseURL': 'https://provider-b.example/v1',
        'llm.profile.provider-b.model': 'provider-b-model',
      }
      return key in values ? values[key] : fallback
    },
  }
  jsonResponse = true
  const profileLlm = new OpenAiChatLlm(new Context(), {}, profileSettings as never)
  assert.equal(profileLlm.configuredFor('provider-b'), true)
  assert.equal(profileLlm.configuredFor('missing'), false)
  const profileAnswer = await profileLlm.chat([{ role: 'user', content: 'hello' }], { profileRef: 'provider-b' })
  assert.equal(profileAnswer, 'profile reply')
  assert.equal(sentUrl, 'https://provider-b.example/v1/chat/completions')
  assert.equal(sentAuthorization, 'Bearer profile-secret')
  assert.equal(sentBody?.model, 'provider-b-model')
  assert.equal(profileLlm.configured, true, 'the selected system default profile determines configured state')
  await profileLlm.chat([{ role: 'user', content: 'default profile' }])
  assert.equal(sentUrl, 'https://provider-b.example/v1/chat/completions', 'calls without an Agent override use the selected default profile')
  await assert.rejects(profileLlm.chat([{ role: 'user', content: 'hello' }], { profileRef: '../missing' }), /格式无效/)
  console.log('✓ named text-model profiles select their own endpoint, model, and credential')

  const progress: string[] = []
  const graphCtx = Object.assign(new Context(), {
    llm: {
      chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
        options?.onToken?.('最终')
        options?.onToken?.('回复')
        return '最终回复'
      },
    },
    tools: { invoke: async () => { throw new Error('tool should not run') } },
    eventLog: { append: () => { throw new Error('stream must stay ephemeral') } },
  })
  const result = await runAgentExecutionGraph({
    ctx: graphCtx as never,
    agentId: 'a_stream_test',
    allowedToolIds: [],
    messages: [{ role: 'user', content: 'test' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) progress.push(delta) },
  })
  assert.equal(result.answer, '最终回复')
  assert.deepEqual(progress, ['最终', '回复'])

  const privateChunks: string[] = []
  const privateCtx = Object.assign(new Context(), {
    llm: {
      chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
        options?.onToken?.('{"toolCalls":')
        options?.onToken?.('[{"args":{"code":"private"}}]}')
        return '{"toolCalls":[{"args":{"code":"private"}}]}'
      },
    },
    tools: { invoke: async () => { throw new Error('invalid tool must not run') } },
    eventLog: { append: () => { throw new Error('tool JSON must stay ephemeral') } },
  })
  await runAgentExecutionGraph({
    ctx: privateCtx as never,
    agentId: 'a_stream_test',
    allowedToolIds: [],
    messages: [{ role: 'user', content: 'test' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) privateChunks.push(delta) },
  })
  assert.deepEqual(privateChunks, [], 'structured tool requests must not reach the human token stream')
  console.log('✓ OpenAI SSE deltas stream to ephemeral human progress; structured tool payloads stay private')
} finally {
  globalThis.fetch = originalFetch
}
