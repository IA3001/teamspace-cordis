import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { OpenAiChatLlm } from '../packages/impl/space-llm-openai/src/index.ts'
import { LlmError } from '../packages/seam/space-llm/src/index.ts'
import { runAgentExecutionGraph } from '../packages/impl/space-agent-runtime/src/execution-graph.ts'
import { appendProgressDelta, MAX_PROGRESS_PREVIEW_CHARACTERS, progressPreviewLabel } from '../packages/client-ui/space-client-ui-teamspace/client/progress.ts'

const originalFetch = globalThis.fetch
let sentBody: Record<string, unknown> | undefined
let sentUrl = ''
let sentAuthorization = ''
let jsonResponse = false
let abortJsonResponse = false
let invalidJsonResponse = false
let disconnectStream = false
let fetchCause: Error | undefined
let responseStatus = 200
let responseBody: Record<string, unknown> = { choices: [{ message: { content: 'profile reply' } }] }
const deltas: string[] = []
globalThis.fetch = (async (url, init) => {
  if (fetchCause) throw new TypeError('fetch failed', { cause: fetchCause })
  sentUrl = String(url)
  sentAuthorization = new Headers(init?.headers).get('authorization') ?? ''
  sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
  if (abortJsonResponse) return {
    ok: true,
    json: async () => { throw new DOMException('The operation was aborted due to timeout', 'AbortError') },
  } as Response
  if (invalidJsonResponse) return {
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token in response') },
  } as Response
  if (jsonResponse) return Response.json(responseBody, { status: responseStatus })
  const encoder = new TextEncoder()
  const chunks = [
    `data: {"choices":[{"delta":{"content":"${disconnectStream ? '已收到' : '你好'}"}}]}\n\n`,
    ...(disconnectStream ? [] : [
    'data: {"choices":[{"delta":{"content":"，团队"}}]}\n\n',
    'data: [DONE]\n\n',
    ]),
  ]
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (disconnectStream) setTimeout(() => controller.error(new Error('network socket dropped')), 0)
      else controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}) as typeof fetch

try {
  const llm = new OpenAiChatLlm(new Context(), {
    apiKey: 'stream-test-key', baseURL: 'https://llm.example/v1', model: 'stream-test-model',
  })
  const answer = await llm.chat([{ role: 'user', content: 'hello' }], { onToken: (delta) => deltas.push(delta) })
  assert.equal(sentBody?.stream, true)
  assert.equal(sentBody?.max_tokens, undefined, 'uncapped legacy configuration preserves provider defaults')
  assert.equal(answer, '你好，团队')
  assert.deepEqual(deltas, ['你好', '，团队'])
  assert.doesNotMatch(JSON.stringify({ answer, deltas }), /stream-test-key/)

  disconnectStream = true
  const interruptedDeltas: string[] = []
  await assert.rejects(
    llm.chat([{ role: 'user', content: 'interrupted stream' }], { onToken: (delta) => interruptedDeltas.push(delta) }),
    (error: unknown) => error instanceof LlmError && error.code === 'http_error' && !error.message.includes('stream-test-key'),
  )
  assert.deepEqual(interruptedDeltas, ['已收到'], 'tokens received before a disconnect remain available as an uncommitted preview')
  disconnectStream = false
  console.log('✓ an interrupted SSE stream keeps received deltas and rejects with a credential-safe error')

  fetchCause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  await assert.rejects(
    llm.chat([{ role: 'user', content: 'network cause' }]),
    (error: unknown) => error instanceof LlmError && error.code === 'http_error' &&
      /ECONNRESET/u.test(error.message) && /连接被对端重置/u.test(error.message) &&
      !error.message.includes('stream-test-key'),
    'network failures preserve a safe low-level cause code for diagnosis',
  )
  fetchCause = undefined
  console.log('✓ network failures retain a credential-safe root cause')

  const profileSettings = {
    get(key: string, fallback: unknown) {
      const values: Record<string, unknown> = {
        'llm.profiles': [{ id: 'provider-b' }],
        'llm.activeProfileRef': 'provider-b',
        'llm.profile.provider-b.apiKey': 'profile-secret',
        'llm.profile.provider-b.baseURL': 'https://provider-b.example/v1',
        'llm.profile.provider-b.model': 'provider-b-model',
        'llm.profile.provider-b.maxOutputTokens': 4096,
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
  assert.equal(sentBody?.max_tokens, 4096, 'a provider profile applies its configured hard output cap')
  await profileLlm.chat([{ role: 'user', content: 'smaller per-call cap' }], { profileRef: 'provider-b', maxTokens: 1024 })
  assert.equal(sentBody?.max_tokens, 1024, 'a per-call output budget can tighten the profile cap')
  await profileLlm.chat([{ role: 'user', content: 'larger per-call request' }], { profileRef: 'provider-b', maxTokens: 8192 })
  assert.equal(sentBody?.max_tokens, 4096, 'a per-call request cannot exceed the administrator profile cap')
  assert.equal(profileLlm.configured, true, 'the selected system default profile determines configured state')
  await profileLlm.chat([{ role: 'user', content: 'default profile' }])
  assert.equal(sentUrl, 'https://provider-b.example/v1/chat/completions', 'calls without an Agent override use the selected default profile')
  await assert.rejects(profileLlm.chat([{ role: 'user', content: 'hello' }], { profileRef: '../missing' }), /格式无效/)
  responseStatus = 400
  responseBody = { error: { message: 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed glm-5-3-flash-260828.', type: 'invalid_request' } }
  await assert.rejects(
    profileLlm.chat([{ role: 'user', content: 'model mismatch' }], { profileRef: 'provider-b', model: 'glm-5-3-flash-260828' }),
    (error: unknown) => error instanceof LlmError && /不被当前供应商接受.*供应商配置的默认模型/s.test(error.message) &&
      !error.message.includes('profile-secret'),
    'unsupported per-Agent model overrides explain how to recover without exposing the API key',
  )
  responseStatus = 200
  abortJsonResponse = true
  await assert.rejects(
    profileLlm.chat([{ role: 'user', content: 'response body timeout' }], { profileRef: 'provider-b', timeoutMs: 1234 }),
    (error: unknown) => error instanceof LlmError && error.code === 'timeout' &&
      /响应读取超时（1234ms/u.test(error.message) && !/不是有效 JSON/u.test(error.message),
    'an aborted response body is reported as a timeout rather than malformed JSON',
  )
  abortJsonResponse = false
  invalidJsonResponse = true
  await assert.rejects(
    profileLlm.chat([{ role: 'user', content: 'invalid JSON body' }], { profileRef: 'provider-b' }),
    (error: unknown) => error instanceof LlmError && error.code === 'http_error' &&
      /响应不是有效 JSON：Unexpected token/u.test(error.message),
    'a malformed JSON body remains a distinct, accurately worded provider error',
  )
  invalidJsonResponse = false
  jsonResponse = true
  responseBody = {} // Syntactically valid JSON with an invalid LLM response shape remains distinct.
  await assert.rejects(
    profileLlm.chat([{ role: 'user', content: 'invalid response body' }], { profileRef: 'provider-b' }),
    (error: unknown) => error instanceof LlmError && error.code === 'empty_response' && /缺 choices/u.test(error.message),
    'a valid JSON response without a completion remains a provider response error',
  )
  responseBody = { choices: [{ message: { content: 'profile reply' } }] }
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

  let preview = { text: '', totalCharacters: 0, truncated: false }
  preview = appendProgressDelta(preview, '长回复：')
  preview = appendProgressDelta(preview, '甲'.repeat(MAX_PROGRESS_PREVIEW_CHARACTERS + 5))
  assert.equal(Array.from(preview.text).length, MAX_PROGRESS_PREVIEW_CHARACTERS)
  assert.equal(preview.text, `甲`.repeat(MAX_PROGRESS_PREVIEW_CHARACTERS), 'long preview retains the most recent content')
  assert.equal(preview.totalCharacters, MAX_PROGRESS_PREVIEW_CHARACTERS + 9)
  assert.equal(preview.truncated, true)
  assert.match(progressPreviewLabel('text-delta', preview), /仅显示末尾 16000\/16009 字符/u)
  assert.equal(progressPreviewLabel('waiting-model', { text: '', totalCharacters: 0, truncated: false }), '回复草稿（生成中）')
  assert.match(progressPreviewLabel('failed', preview), /^任务失败（未提交回复草稿）/u)
  assert.match(progressPreviewLabel('cancelled', preview), /^任务已撤回（未提交回复草稿）/u)
  assert.equal(progressPreviewLabel('completed', { text: '完整答复', totalCharacters: 4, truncated: false }), '回复流已完成（预览）')
  console.log('✓ long progress previews report retained length and terminal task states')

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

  let fencedRound = 0
  const fencedChunks: string[] = []
  const fencedCtx = Object.assign(new Context(), {
    llm: {
      chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
        fencedRound++
        if (fencedRound === 1) {
          const parts = [
            '```json\n{"toolCalls":',
            '[{"toolId":"tool.workspace.write","args":{"path":"projects/demo/src/index.js","content":"export const answer = 42"}}]}\n```',
          ]
          for (const part of parts) options?.onToken?.(part)
          return parts.join('')
        }
        const parts = ['## 已完成\n', '已写入文件。']
        for (const part of parts) options?.onToken?.(part)
        return parts.join('')
      },
    },
    tools: { invoke: async (toolId: string) => ({ toolId, ok: true, output: 'written', costMs: 1 }) },
    eventLog: { append: () => { throw new Error('test does not persist tool events') } },
  })
  const fencedResult = await runAgentExecutionGraph({
    ctx: fencedCtx as never,
    agentId: 'a_stream_test',
    allowedToolIds: ['tool.workspace.write'],
    messages: [
      { role: 'system', content: '角色提示\n\n运行规则' },
      { role: 'user', content: 'write a file' },
    ],
    model: 'audit-test-model',
    profileRef: 'audit-test-profile',
    messageSources: ['分段系统提示词', '当前用户任务'],
    systemSections: [
      { label: '角色提示', source: 'prompt.coding', content: '角色提示' },
      { label: '运行规则', source: 'Agent Runtime', content: '运行规则' },
    ],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) fencedChunks.push(delta) },
  })
  assert.equal(fencedResult.answer, '## 已完成\n已写入文件。')
  assert.equal(fencedResult.modelTrace.length, 2, 'each provider request is retained as a separate audit step')
  assert.equal(fencedResult.modelTrace[0]?.model, 'audit-test-model')
  assert.equal(fencedResult.modelTrace[0]?.profileRef, 'audit-test-profile')
  assert.equal(fencedResult.modelTrace[0]?.request[0]?.source, '分段系统提示词')
  assert.deepEqual(fencedResult.modelTrace[0]?.request[0]?.sections?.map((section) => section.source), ['prompt.coding', 'Agent Runtime'])
  assert.match(fencedResult.modelTrace[0]?.response ?? '', /^```json\n\{"toolCalls"/u, 'the original fenced model response is retained')
  assert.equal(fencedResult.modelTrace[0]?.toolCalls[0]?.toolId, 'tool.workspace.write')
  assert.equal(fencedResult.modelTrace[0]?.toolCalls[0]?.status, 'success')
  assert.equal(fencedResult.modelTrace[0]?.toolCalls[0]?.result, 'written')
  assert.equal(fencedResult.modelTrace[1]?.request.at(-1)?.source, '工具结果：tool.workspace.write')
  assert.equal(fencedResult.modelTrace[1]?.response, '## 已完成\n已写入文件。')
  assert.deepEqual(fencedChunks, ['## 已完成\n', '已写入文件。'], 'fenced tool JSON stays private while the final Markdown streams')
  console.log('✓ fenced tool envelopes stay hidden and the final Markdown answer streams incrementally')

  const dsmlResponse = '<|DSML|>calls><|DSML|>invoke name="tool.code.execute"><|DSML|>parameter name="args" string="false">{"filename":"scripts/run-discount-tests.mjs","code":"console.log(1)"}</|DSML|></|DSML|>'
  let dsmlRound = 0
  let dsmlInvocation = ''
  const dsmlVisible: string[] = []
  const dsmlCtx = Object.assign(new Context(), {
    llm: { chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
      dsmlRound++
      const response = dsmlRound === 1 ? dsmlResponse : '测试通过。'
      options?.onToken?.(response.slice(0, 15))
      options?.onToken?.(response.slice(15))
      return response
    } },
    tools: { invoke: async (toolId: string, args: string) => {
      dsmlInvocation = `${toolId}:${args}`
      return { toolId, ok: true, output: 'tests passed', costMs: 4 }
    } },
    eventLog: { append: () => { throw new Error('test does not persist tool events') } },
  })
  const dsmlResult = await runAgentExecutionGraph({
    ctx: dsmlCtx as never, agentId: 'a_stream_test', allowedToolIds: ['tool.code.execute'],
    messages: [{ role: 'user', content: '测试这个实现' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) dsmlVisible.push(delta) },
  })
  assert.match(dsmlInvocation, /^tool\.code\.execute:/u, 'DSML call must dispatch to the configured tool')
  assert.deepEqual(JSON.parse(dsmlInvocation.slice(dsmlInvocation.indexOf(':') + 1)), { filename: 'scripts/run-discount-tests.mjs', code: 'console.log(1)' })
  assert.equal(dsmlResult.answer, '测试通过。')
  assert.equal(dsmlResult.modelTrace[0]?.toolCalls[0]?.status, 'success')
  assert.deepEqual(dsmlVisible, ['测试通过。'], 'DSML wire protocol never leaks to the human-visible stream')
  console.log('✓ DSML tool protocol is executed privately and does not leak into Agent replies')

  const spacedDsmlResponse = '<|DSML |>calls><|DSML |>invoke name="tool.code.execute"><|DSML |>parameter name="args" string="false">{"filename":"scripts/run-discount-tests.mjs","code":"console.log(2)"}</|DSML |></|DSML |>'
  let spacedDsmlRound = 0
  let spacedDsmlInvocation = ''
  const spacedDsmlVisible: string[] = []
  const spacedDsmlCtx = Object.assign(new Context(), {
    llm: { chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
      spacedDsmlRound++
      const response = spacedDsmlRound === 1 ? spacedDsmlResponse : '间距兼容正常。'
      for (let index = 0; index < response.length; index += 11) options?.onToken?.(response.slice(index, index + 11))
      return response
    } },
    tools: { invoke: async (toolId: string, args: string) => {
      spacedDsmlInvocation = `${toolId}:${args}`
      return { toolId, ok: true, output: 'tests passed', costMs: 4 }
    } },
    eventLog: { append: () => { throw new Error('test does not persist tool events') } },
  })
  const spacedDsmlResult = await runAgentExecutionGraph({
    ctx: spacedDsmlCtx as never, agentId: 'a_stream_test', allowedToolIds: ['tool.code.execute'],
    messages: [{ role: 'user', content: '测试兼容格式' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) spacedDsmlVisible.push(delta) },
  })
  assert.match(spacedDsmlInvocation, /^tool\.code\.execute:/u, 'whitespace-variant DSML call must dispatch to the configured tool')
  assert.deepEqual(JSON.parse(spacedDsmlInvocation.slice(spacedDsmlInvocation.indexOf(':') + 1)), { filename: 'scripts/run-discount-tests.mjs', code: 'console.log(2)' })
  assert.equal(spacedDsmlResult.answer, '间距兼容正常。')
  assert.deepEqual(spacedDsmlVisible, ['间距兼容正常。'], 'whitespace-variant DSML syntax stays private throughout streaming')
  console.log('✓ whitespace-variant DSML calls are parsed and never leak while streaming')

  const wrappedDsmlResponse = '<| | DSML | | calls><| | DSML | | invoke name="toolCalls">[{"toolId":"tool.code.execute","args":{"filename":"probe-workspace.mjs","code":"console.log(3)"}}]</| | DSML | |></| | DSML | |>'
  let wrappedDsmlRound = 0
  let wrappedDsmlInvocation = ''
  const wrappedDsmlVisible: string[] = []
  const wrappedDsmlCtx = Object.assign(new Context(), {
    llm: { chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
      wrappedDsmlRound++
      const response = wrappedDsmlRound === 1 ? wrappedDsmlResponse : '工具调用已完成。'
      for (let index = 0; index < response.length; index += 7) options?.onToken?.(response.slice(index, index + 7))
      return response
    } },
    tools: { invoke: async (toolId: string, args: string) => {
      wrappedDsmlInvocation = `${toolId}:${args}`
      return { toolId, ok: true, output: 'workspace inspected', costMs: 3 }
    } },
    eventLog: { append: () => { throw new Error('test does not persist wrapped DSML tool events') } },
  })
  const wrappedDsmlResult = await runAgentExecutionGraph({
    ctx: wrappedDsmlCtx as never, agentId: 'a_stream_test', allowedToolIds: ['tool.code.execute'],
    messages: [{ role: 'user', content: '查看工作区' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) wrappedDsmlVisible.push(delta) },
  })
  assert.match(wrappedDsmlInvocation, /^tool\.code\.execute:/u, 'wrapped DSML toolCalls arrays must dispatch')
  assert.deepEqual(JSON.parse(wrappedDsmlInvocation.slice(wrappedDsmlInvocation.indexOf(':') + 1)), { filename: 'probe-workspace.mjs', code: 'console.log(3)' })
  assert.equal(wrappedDsmlResult.answer, '工具调用已完成。')
  assert.equal(wrappedDsmlVisible.join(''), '工具调用已完成。', 'malformed spaced DSML markers and wrapped toolCalls never leak during streaming')
  console.log('✓ wrapped toolCalls DSML dialect stays private and executes the requested tool')

  const repeatedEnvelope = '{"toolCalls":[{"toolId":"tool.workspace.read","args":{"path":"notes/status.md"}}]}'
  let repeatedRound = 0
  let repeatedInvocations = 0
  const repeatedCtx = Object.assign(new Context(), {
    llm: {
      chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
        repeatedRound++
        const response = repeatedRound === 1
          ? `${repeatedEnvelope}\n${repeatedEnvelope}`
          : repeatedEnvelope
        options?.onToken?.(response)
        return response
      },
    },
    tools: { invoke: async (toolId: string) => { repeatedInvocations++; return { toolId, ok: true, output: 'status', costMs: 1 } } },
    eventLog: { append: () => { throw new Error('test does not persist tool events') } },
  })
  const repeatedResult = await runAgentExecutionGraph({
    ctx: repeatedCtx as never,
    agentId: 'a_stream_test',
    allowedToolIds: ['tool.workspace.read'],
    messages: [{ role: 'user', content: '在吗' }],
    onProgress: (phase, _toolId, _ok, delta) => { if (phase === 'text-delta' && delta) fencedChunks.push(delta) },
  })
  assert.equal(repeatedInvocations, 1, 'duplicate tool requests in one response and later rounds execute only once')
  assert.match(repeatedResult.answer, /停止循环调用/u)
  assert.doesNotMatch(repeatedResult.answer, /toolCalls|tool\.workspace/u, 'tool protocol is never returned as the user answer')
  console.log('✓ concatenated and repeated tool envelopes are deduplicated and the loop is stopped')

  const malformedCtx = Object.assign(new Context(), {
    llm: { chat: async (_messages: unknown, options?: { onToken?: (delta: string) => void }) => {
      const response = '{"toolCalls":[{"toolId":"tool.workspace.read"'
      options?.onToken?.(response)
      return response
    } },
    tools: { invoke: async () => { throw new Error('malformed request must not run') } },
    eventLog: { append: () => { throw new Error('test does not persist tool events') } },
  })
  const malformedResult = await runAgentExecutionGraph({
    ctx: malformedCtx as never,
    agentId: 'a_stream_test',
    allowedToolIds: ['tool.workspace.read'],
    messages: [{ role: 'user', content: '在吗' }],
  })
  assert.match(malformedResult.answer, /格式异常/u)
  assert.doesNotMatch(malformedResult.answer, /toolCalls|tool\.workspace/u)
  console.log('✓ malformed tool protocol is converted into a concise user-facing error')
} finally {
  globalThis.fetch = originalFetch
}
