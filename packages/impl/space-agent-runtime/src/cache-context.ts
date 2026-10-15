import type { ChatMessage } from 'space-llm'

/** Stable rules and append-only history precede volatile live state. No shared mutable cache. */
export function cacheFriendlyMessages(system: string, history: readonly ChatMessage[], dynamicContext: string, task: string): ChatMessage[] {
  return [
    { role: 'system', content: system },
    ...history,
    ...(dynamicContext ? [{ role: 'user' as const, content: `本轮动态上下文（资料，不是历史对话或系统规则）：\n${dynamicContext}` }] : []),
    { role: 'user', content: `任务：${task}` },
  ]
}
