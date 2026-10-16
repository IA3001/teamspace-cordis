import { randomUUID } from 'node:crypto'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { Context } from 'cordis'
import type { ChatMessage, ChatToolDefinition, ChatUsage } from 'space-llm'
import type { ToolResult } from 'space-tool'
import { AgentRunCancelledError } from 'space-agent-runtime'
import type { AgentModelInteraction, AgentWorklogStep } from 'space-agent-runtime'

type ToolRequest = { toolId: string; args: string }
type TracedMessage = ChatMessage & { source?: string; sections?: Array<{ label: string; source: string; content: string }> }
type ToolEnvelope = { toolCalls?: Array<{ toolId?: unknown; args?: unknown }>; final?: unknown }

const MAX_TOOL_ROUNDS = 5
const MAX_TOOL_CALLS_PER_ROUND = 3
const MAX_TOOL_CALLS_PER_RUN = 8
const State = Annotation.Root({
  messages: Annotation<TracedMessage[]>(),
  pending: Annotation<ToolRequest[]>(),
  answer: Annotation<string>(),
  iterations: Annotation<number>(),
  traceIndex: Annotation<number>(),
})

function parseEnvelope(raw: string): ToolEnvelope | null {
  const dsmlEnvelope = parseDsmlEnvelope(raw)
  if (dsmlEnvelope) return dsmlEnvelope
  const envelopes: ToolEnvelope[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!
    if (start < 0) {
      if (char === '{') { start = index; depth = 1; inString = false; escaped = false }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      try {
        const value = JSON.parse(raw.slice(start, index + 1)) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as ToolEnvelope).toolCalls)) {
          envelopes.push(value as ToolEnvelope)
        }
      } catch { /* Ignore prose braces and malformed JSON fragments. */ }
      start = -1
    }
  }
  if (!envelopes.length) return null
  const toolCalls = envelopes.flatMap((envelope) => envelope.toolCalls ?? [])
  const final = [...envelopes].reverse().find((envelope) => envelope.final != null)?.final
  return { toolCalls, ...(final == null ? {} : { final }) }
}

/** Some OpenAI-compatible coding models return their tool protocol as DSML text
 * instead of the JSON envelope requested by the Agent runtime. Treat it as a
 * private tool request and never let that wire syntax become a chat answer. */
function parseDsmlEnvelope(raw: string): ToolEnvelope | null {
  // Some compatible endpoints insert whitespace inside the special-token
  // spelling (for example `<|DSML |>calls>`). Normalize only the marker; the
  // payload remains byte-for-byte intact for JSON parsing and audit traces.
  const normalized = raw
    .replace(/<\|\s*(?:\|\s*)*DSML\s*\|+\s*\|\s*(calls|invoke|parameter)\b/giu, '<|DSML|>$1')
    .replace(/<\/?\|\s*(?:\|\s*)*DSML\s*\|+(?:\s*\|+)?\s*>/giu, (marker) => marker.startsWith('</') ? '</|DSML|>' : '<|DSML|>')
  if (!/<\|DSML\|>\s*calls\s*>/iu.test(normalized)) return null
  const invokePattern = /<\|DSML\|>\s*invoke\s+name\s*=\s*(["'])([^"']+)\1\s*>/giu
  const invokes = [...normalized.matchAll(invokePattern)]
  if (!invokes.length) return { toolCalls: [] }
  const toolCalls: NonNullable<ToolEnvelope['toolCalls']> = []
  for (let index = 0; index < invokes.length; index++) {
    const invoke = invokes[index]!
    const start = (invoke.index ?? 0) + invoke[0].length
    const end = invokes[index + 1]?.index ?? normalized.length
    const body = normalized.slice(start, end)
    // Some provider profiles wrap the normal JSON tool-call array in a single
    // DSML `invoke name="toolCalls"` block instead of emitting one `invoke`
    // per tool with an `args` parameter.
    if (invoke[2] === 'toolCalls') {
      const payload = body.replace(/(?:<\|DSML\|>|<\/\|DSML\|>)[\s\S]*$/u, '').trim()
      try {
        const parsed = JSON.parse(payload) as unknown
        const calls = Array.isArray(parsed) ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as ToolEnvelope).toolCalls)
            ? (parsed as ToolEnvelope).toolCalls!
            : null
        if (!calls) return { toolCalls: [] }
        toolCalls.push(...calls as NonNullable<ToolEnvelope['toolCalls']>)
        continue
      } catch {
        return { toolCalls: [] }
      }
    }
    const parameterPattern = /<\|DSML\|>\s*parameter\s+name\s*=\s*(["'])args\1(?:\s+string\s*=\s*(["'])(?:true|false)\2)?\s*>/iu
    const parameter = parameterPattern.exec(body)
    if (!parameter) return { toolCalls: [] }
    const argumentText = body.slice(parameter.index + parameter[0].length)
      .replace(/(?:<\|DSML\|>|<\/\|DSML\|>)[\s\S]*$/u, '')
      .trim()
    try {
      toolCalls.push({ toolId: invoke[2], args: JSON.parse(argumentText) })
    } catch {
      return { toolCalls: [] }
    }
  }
  return { toolCalls }
}

type EnvelopeStreamState = 'pending' | 'tool' | 'answer'

/** Decide whether the beginning of a streamed response is a private tool envelope.
 * Models sometimes wrap the JSON protocol in a Markdown fence; do not leak that
 * protocol into the user's live reply bubble while waiting for the final parse. */
function classifyEnvelopeStream(text: string): EnvelopeStreamState {
  let candidate = text.trimStart()
  if (!candidate) return 'pending'
  const normalized = candidate
    .replace(/<\|\s*(?:\|\s*)*DSML\s*\|+\s*\|\s*(calls|invoke|parameter)\b/giu, '<|DSML|>$1')
    .replace(/<\/?\|\s*(?:\|\s*)*DSML\s*\|+(?:\s*\|+)?\s*>/giu, (marker) => marker.startsWith('</') ? '</|DSML|>' : '<|DSML|>')
  const dsmlStart = '<|DSML|>calls>'
  if (dsmlStart.startsWith(normalized)) return 'pending'
  if (normalized.startsWith(dsmlStart) || /^<\|DSML\|>\s*calls\s*>/iu.test(normalized)) return 'tool'
  // Hold malformed/space-split DSML prefixes while they are still being
  // streamed. Releasing them as ordinary prose was the leak seen in production.
  if (/^<\|\s*(?:\|\s*)*D(?:S(?:M(?:L)?)?)?/iu.test(candidate) && candidate.length < 120 && !/>\s*[^\n]/u.test(candidate)) return 'pending'
  if ('<|DSML|>'.startsWith(normalized)) return 'pending'
  if (candidate.startsWith('`') || candidate.startsWith('~')) {
    const fence = /^(?:`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/.exec(candidate)
    if (!fence) return candidate.length < 3 ? 'pending' : 'answer'
    const language = fence[1]!.trim().toLowerCase()
    if (language && language !== 'json' && language !== 'javascript' && language !== 'js') return 'answer'
    if (!language && !candidate.includes('\n')) return 'pending'
    candidate = candidate.slice(fence[0].length).trimStart()
    if (!candidate) return 'pending'
  }
  if (!candidate.startsWith('{')) return 'answer'

  const keyPrefix = /^\{\s*"([^"\\]*)/.exec(candidate)
  if (!keyPrefix) return candidate.length < 3 || /^\{\s*$/.test(candidate) ? 'pending' : 'answer'
  const key = keyPrefix[1]!
  if (!'toolCalls'.startsWith(key)) return 'answer'
  if (key !== 'toolCalls') return 'pending'
  if (!/^\{\s*"toolCalls"\s*:/.test(candidate)) return 'pending'
  return 'tool'
}

function containsToolProtocol(text: string): boolean {
  return /"toolCalls"\s*:|<\|\s*(?:\|\s*)*DSML\s*\|+\s*\|\s*calls\s*>|<\|\s*(?:\|\s*)*DSML\s*\|+(?:\s*\|+)?\s*>\s*calls\s*>/iu.test(text)
}

function toRequests(envelope: ToolEnvelope): ToolRequest[] {
  return (envelope.toolCalls ?? []).flatMap((call) => {
    if (typeof call.toolId !== 'string' || !call.toolId.trim()) return []
    return [{ toolId: call.toolId, args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}) }]
  })
}

function activityArgs(args: string): string {
  try {
    const summarize = (value: unknown, depth = 0, key = ''): unknown => {
      if (/code|content|password|secret|token|api.?key|credential/i.test(key)) return '[已隐藏]'
      if (typeof value === 'string') return safeActivityText(value, 120)
      if (Array.isArray(value)) return depth > 2 ? '[嵌套数据]' : value.slice(0, 8).map((item) => summarize(item, depth + 1))
      if (value && typeof value === 'object') {
        if (depth > 2) return '[嵌套数据]'
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 16)
          .map(([childKey, child]) => [childKey, summarize(child, depth + 1, childKey)]))
      }
      return value
    }
    return JSON.stringify(summarize(JSON.parse(args))).slice(0, 500)
  } catch {
    return '[参数不可显示]'
  }
}

function safeActivityText(value: string, max = 1000): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[已隐藏]')
    .slice(0, max)
}

function safeAuditText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[凭据已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[凭据已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[凭据已隐藏]')
}

export async function runAgentExecutionGraph(input: {
  ctx: Context
  agentId: string
  sessionId?: string
  model?: string
  profileRef?: string
  allowedToolIds: readonly string[]
  messages: ChatMessage[]
  messageSources?: string[]
  messageSections?: Array<Array<{ label: string; source: string; content: string }> | undefined>
  systemSections?: Array<{ label: string; source: string; content: string }>
  signal?: AbortSignal
  onUsage?: (usage: ChatUsage) => void
  onModelTrace?: (trace: AgentModelInteraction[]) => void
  onProgress?: (phase: 'waiting-model' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta', toolId?: string, ok?: boolean, delta?: string, step?: Partial<AgentWorklogStep>) => void
}): Promise<{ answer: string; toolResults: ToolResult[]; modelTrace: AgentModelInteraction[] }> {
  const toolResults: ToolResult[] = []
  const modelTrace: AgentModelInteraction[] = []
  const publishTrace = () => input.onModelTrace?.(structuredClone(modelTrace))
  const seenToolRequests = new Set<string>()
  const toolDefinitions: ChatToolDefinition[] = (input.ctx.tools?.list?.() ?? [])
    .filter((tool) => input.allowedToolIds.includes(tool.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((tool, index) => ({
      type: 'function',
      toolId: tool.id,
      function: {
        name: `cordis_tool_${index}`,
        description: `${tool.id} — ${tool.title}：${tool.description ?? tool.capabilities.join('、')}`,
        parameters: tool.parameters ?? { type: 'object', additionalProperties: true },
      },
    }))
  const model = async (state: typeof State.State) => {
    if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
    input.onProgress?.('waiting-model', undefined, undefined, undefined, {
      detail: `已提交 ${state.messages.length} 条上下文消息，等待模型供应商返回首个响应`,
    })
    let buffered = ''
    const stream = { state: 'pending' as EnvelopeStreamState }
    const streamToHuman = (text: string) => {
      if (!text) return
      input.onProgress?.('text-delta', undefined, undefined, text)
    }
    const trace: AgentModelInteraction = {
      index: modelTrace.length + 1,
      model: input.model ?? null,
      profileRef: input.profileRef ?? null,
      startedAt: new Date().toISOString(),
      status: 'failed',
      request: state.messages.map((message, index) => ({
        role: message.role,
        source: message.source ?? input.messageSources?.[index] ?? (index === 0 ? '系统提示词（来源未细分）' : '上下文消息（来源未标注）'),
        content: safeAuditText(message.content),
        ...(message.sections?.length
          ? { sections: message.sections.map((section) => ({ ...section, content: safeAuditText(section.content) })) }
          : index === 0 && input.systemSections?.length
            ? { sections: input.systemSections.map((section) => ({ ...section, content: safeAuditText(section.content) })) }
            : {}),
      })),
      toolCalls: [],
    }
    modelTrace.push(trace)
    publishTrace()
    let raw: string
    try {
      raw = await input.ctx.llm.chat(state.messages.map(({ role, content }) => ({ role, content })), {
        // A referenced provider profile owns its model selection. `input.model`
        // remains useful as the audited/displayed model name, but passing it to
        // the adapter would override the profile's configured model.
        model: input.profileRef ? undefined : input.model,
        profileRef: input.profileRef,
        signal: input.signal,
        onUsage: input.onUsage,
        ...(toolDefinitions.length ? { tools: toolDefinitions } : {}),
        onToken: (delta) => {
          buffered += delta
          // Keep tool protocol (including fenced JSON) private. Ordinary Markdown
          // is released as soon as its opening makes the response type clear.
          if (stream.state === 'pending') {
            stream.state = classifyEnvelopeStream(buffered)
            if (stream.state === 'pending' || stream.state === 'tool') return
            streamToHuman(buffered)
            return
          }
          if (stream.state === 'tool') return
          streamToHuman(delta)
        },
      })
      trace.completedAt = new Date().toISOString()
      trace.status = 'completed'
      trace.response = safeAuditText(raw)
      if (trace.response.length > 250_000) {
        trace.response = trace.response.slice(0, 250_000)
        trace.responseTruncated = true
      }
      publishTrace()
    } catch (error) {
      trace.completedAt = new Date().toISOString()
      trace.error = safeAuditText((error as Error).message || String(error))
      publishTrace()
      throw error
    }
    if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
    const envelope = parseEnvelope(raw)
    const parsedRequests = envelope ? toRequests(envelope) : []
    trace.toolCalls = parsedRequests.map((request) => ({ toolId: request.toolId, args: safeAuditText(request.args) }))
    publishTrace()
    const freshRequests = parsedRequests.filter((request) => {
      const signature = `${request.toolId}\n${request.args}`
      if (seenToolRequests.has(signature)) return false
      seenToolRequests.add(signature)
      return true
    })
    const availableToolSlots = Math.max(0, MAX_TOOL_CALLS_PER_RUN - toolResults.length)
    if (envelope && parsedRequests.length !== (envelope.toolCalls?.length ?? 0)) {
      throw new Error('Agent 工具调用参数格式无效，系统已拦截未执行的请求。请检查工具名称与 JSON 参数。')
    }
    if (parsedRequests.length > MAX_TOOL_CALLS_PER_ROUND || parsedRequests.length > availableToolSlots) {
      throw new Error('本轮工具调用超过安全上限，系统已拦截全部未执行请求。请缩小任务范围后重试。')
    }
    if (freshRequests.length !== parsedRequests.length) {
      throw new Error('检测到 Agent 重复请求工具，系统已停止并拦截未执行的重复请求。请明确下一步目标后重试。')
    }
    const requests = freshRequests.slice(0, Math.min(MAX_TOOL_CALLS_PER_ROUND, availableToolSlots))
    if (!requests.length) {
      if (toolResults.some((result) => !result.ok)) {
        throw new Error('至少一个工具调用未成功执行，系统已阻止 Agent 将本轮标记为完成。请查看失败的工具记录并重试。')
      }
      const finalText = envelope?.final == null ? null : String(envelope.final)
      const answer = finalText !== null
        ? containsToolProtocol(finalText) ? 'Agent 最终答复中包含未处理的工具协议，系统已拦截该内容。请重试并检查 Agent 的工具配置。' : finalText
        : parsedRequests.length > 0 && freshRequests.length === 0
          ? '检测到 Agent 在重复请求同一工具，系统已停止循环调用。请明确下一步目标后重试。'
          : freshRequests.length > 0 && availableToolSlots === 0
            ? '本轮工具调用已达到安全上限，系统已停止继续调用。请缩小任务范围后重试。'
          : envelope || stream.state === 'tool' ? 'Agent 工具调用格式异常，系统已拦截未执行的请求。请重试；若重复发生，请检查 Agent 的工具配置与提示词。'
          : containsToolProtocol(raw) ? 'Agent 返回了未处理的工具协议，系统已拦截该内容。请重试并检查 Agent 的工具配置。' : raw
      if (containsToolProtocol(finalText === null ? raw : String(finalText)) ||
          (envelope && (parsedRequests.length === 0 || freshRequests.length === 0)) ||
          (freshRequests.length > 0 && availableToolSlots === 0)) {
        throw new Error(answer)
      }
      // A structured final field is also private until validated; replay its
      // human-facing contents once if it was held back as JSON.
      if (stream.state === 'tool' && answer && envelope?.final != null) streamToHuman(answer)
      else if (stream.state === 'pending' && raw) streamToHuman(raw)
      return { answer, pending: [], iterations: state.iterations + 1 }
    }
    if (state.iterations >= MAX_TOOL_ROUNDS || toolResults.length >= MAX_TOOL_CALLS_PER_RUN) {
      throw new Error('Agent 工具调用轮数已达安全上限，系统已拦截未执行请求；本轮未完成。请缩小任务范围后重试。')
    }
    return {
      answer: '', pending: requests, iterations: state.iterations + 1,
      messages: [...state.messages, { role: 'assistant' as const, content: raw, source: `第 ${trace.index} 轮模型原始响应（供下一轮上下文使用）` }],
      traceIndex: trace.index - 1,
    }
  }

  const executeTools = async (state: typeof State.State) => {
    const resultMessages: TracedMessage[] = []
    for (const request of state.pending) {
      if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
      input.onProgress?.('tool-start', request.toolId, undefined, undefined, {
        kind: 'tool', status: 'running', inputSummary: activityArgs(request.args),
      })
      const started = Date.now()
      let result: ToolResult
      if (!input.allowedToolIds.includes(request.toolId)) {
        result = { toolId: request.toolId, ok: false, code: 'not_configured', output: '该工具未在此 Agent 的工具配置中启用', costMs: 0 }
      } else {
        try {
          result = await input.ctx.tools.invoke(request.toolId, request.args, {
            id: input.agentId,
            sessionId: input.sessionId,
            signal: input.signal,
          })
        } catch (error) {
          result = { toolId: request.toolId, ok: false, code: 'tool_error', output: (error as Error).message, costMs: Date.now() - started }
        }
      }
      if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
      toolResults.push(result)
      input.onProgress?.('tool-finish', result.toolId, result.ok, undefined, {
        kind: 'tool', status: result.ok ? 'success' : 'failed',
        resultSummary: safeActivityText(result.output), durationMs: result.costMs,
      })
      resultMessages.push({
        role: 'user',
        content: `工具结果 ${result.toolId}（${result.ok ? '成功' : `失败:${result.code ?? 'error'}`}）：\n${result.output.slice(0, 8000)}`,
        source: `工具结果：${result.toolId}`,
      })
      const traceCall = modelTrace[state.traceIndex]?.toolCalls.find((call) => call.toolId === request.toolId && !call.status)
      if (traceCall) Object.assign(traceCall, {
        status: result.ok ? 'success' as const : 'failed' as const,
        ...(result.ok ? { result: safeAuditText(result.output) } : { error: `${result.code ?? 'error'}：${safeAuditText(result.output)}` }),
        durationMs: result.costMs,
      })
      publishTrace()
      if (input.sessionId) {
        input.ctx.eventLog.append({
          id: randomUUID(), sessionId: input.sessionId, authorId: null, phaseId: null,
          authorKind: 'system', kind: 'system',
          text: `${input.agentId} 调用工具 ${result.toolId}：${result.ok ? '成功' : '失败'}`,
          mentions: [], replyMode: '',
          toolCalls: [{
            name: result.toolId,
            args: activityArgs(request.args),
            result: result.ok ? safeActivityText(result.output, 1200) : undefined,
            err: result.ok ? undefined : `${result.code ?? 'error'}：${safeActivityText(result.output, 400)}`,
          }],
        })
      }
    }
    return { messages: [...state.messages, ...resultMessages], pending: [] }
  }

  const graph = new StateGraph(State)
    .addNode('model', model)
    .addNode('execute_tools', executeTools)
    .addNode('finish', () => ({}))
    .addEdge(START, 'model')
    .addConditionalEdges('model', (state) => state.pending.length ? 'execute_tools' : 'finish')
    .addEdge('execute_tools', 'model')
    .addEdge('finish', END)
    .compile()

  const initialMessages: TracedMessage[] = input.messages.map((message, index) => ({
    ...message,
    source: input.messageSources?.[index] ?? (index === 0 ? '系统提示词（来源未细分）' : '上下文消息（来源未标注）'),
    ...((input.messageSections?.[index] ?? (index === 0 ? input.systemSections : undefined))?.length
      ? { sections: input.messageSections?.[index] ?? input.systemSections } : {}),
  }))
  const result = await graph.invoke({ messages: initialMessages, pending: [], answer: '', iterations: 0, traceIndex: -1 })
  return { answer: result.answer, toolResults, modelTrace }
}
