import { randomUUID } from 'node:crypto'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { Context } from 'cordis'
import type { ChatMessage } from 'space-llm'
import type { ToolResult } from 'space-tool'
import { AgentRunCancelledError } from 'space-agent-runtime'
import type { AgentWorklogStep } from 'space-agent-runtime'

type ToolRequest = { toolId: string; args: string }
type ToolEnvelope = { toolCalls?: Array<{ toolId?: unknown; args?: unknown }>; final?: unknown }

const MAX_TOOL_ROUNDS = 5
const MAX_TOOL_CALLS_PER_ROUND = 3
const State = Annotation.Root({
  messages: Annotation<ChatMessage[]>(),
  pending: Annotation<ToolRequest[]>(),
  answer: Annotation<string>(),
  iterations: Annotation<number>(),
})

function parseEnvelope(raw: string): ToolEnvelope | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const envelope = value as ToolEnvelope
    return Array.isArray(envelope.toolCalls) ? envelope : null
  } catch {
    return null
  }
}

function toRequests(envelope: ToolEnvelope): ToolRequest[] {
  return (envelope.toolCalls ?? []).slice(0, MAX_TOOL_CALLS_PER_ROUND).flatMap((call) => {
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

export async function runAgentExecutionGraph(input: {
  ctx: Context
  agentId: string
  sessionId?: string
  model?: string
  profileRef?: string
  allowedToolIds: readonly string[]
  messages: ChatMessage[]
  signal?: AbortSignal
  onProgress?: (phase: 'waiting-model' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta', toolId?: string, ok?: boolean, delta?: string, step?: Partial<AgentWorklogStep>) => void
}): Promise<{ answer: string; toolResults: ToolResult[] }> {
  const toolResults: ToolResult[] = []
  const model = async (state: typeof State.State) => {
    if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
    input.onProgress?.('waiting-model', undefined, undefined, undefined, {
      detail: `已提交 ${state.messages.length} 条上下文消息，等待模型供应商返回首个响应`,
    })
    let buffered = ''
    let streamFinalText = false
    const streamToHuman = (text: string) => {
      if (!text) return
      input.onProgress?.('text-delta', undefined, undefined, text)
    }
    const raw = await input.ctx.llm.chat(state.messages, {
      model: input.model,
      profileRef: input.profileRef,
      signal: input.signal,
      onToken: (delta) => {
        buffered += delta
        // Tool requests use a JSON envelope. Keep that private and only stream
        // ordinary final answer text to the human-facing progress channel.
        if (!streamFinalText) {
          const first = buffered.trimStart()[0]
          if (!first) return
          if (first === '{') return
          streamFinalText = true
          streamToHuman(buffered)
          return
        }
        streamToHuman(delta)
      },
    })
    if (input.signal?.aborted) throw new AgentRunCancelledError('execution graph')
    const envelope = parseEnvelope(raw)
    const requests = envelope ? toRequests(envelope) : []
    if (!requests.length) return { answer: envelope?.final == null ? raw : String(envelope.final), pending: [], iterations: state.iterations + 1 }
    if (state.iterations >= MAX_TOOL_ROUNDS) {
      return { answer: '工具调用轮数已达上限；请基于现有结果给出结论或缩小任务。', pending: [], iterations: state.iterations + 1 }
    }
    return {
      answer: '', pending: requests, iterations: state.iterations + 1,
      messages: [...state.messages, { role: 'assistant' as const, content: raw }],
    }
  }

  const executeTools = async (state: typeof State.State) => {
    const resultMessages: ChatMessage[] = []
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
      })
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

  const result = await graph.invoke({ messages: input.messages, pending: [], answer: '', iterations: 0 })
  return { answer: result.answer, toolResults }
}
