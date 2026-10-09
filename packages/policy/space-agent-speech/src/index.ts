import type { SessionEvent } from 'space-event'

export type AgentSpeechMode = 'passive' | 'proactive'
export type AgentSpeechBlockReason = 'proactive_disabled' | 'consecutive_proactive'

export interface AgentSpeechDecision {
  allowed: boolean
  mode: AgentSpeechMode
  reason?: AgentSpeechBlockReason
}

function isPassiveReply(agentId: string, sourceEventId: string | null | undefined,
  events: readonly SessionEvent[]): boolean {
  if (!sourceEventId) return false
  const trigger = events.find((event) => event.id === sourceEventId)
  return Boolean(trigger && !trigger.voided && trigger.kind === 'message' &&
    trigger.authorKind === 'human' && trigger.mentions.includes(agentId))
}

/** Direct human @ replies reset an Agent's proactive allowance; passive history never does. */
export function decideAgentSpeech(
  agentId: string,
  speechPolicy: string | undefined,
  sourceEventId: string | null | undefined,
  events: readonly SessionEvent[],
): AgentSpeechDecision {
  if (isPassiveReply(agentId, sourceEventId, events)) return { allowed: true, mode: 'passive' }
  if (speechPolicy !== 'proactive') {
    return { allowed: false, mode: 'proactive', reason: 'proactive_disabled' }
  }
  const previous = events
    .filter((event) => event.authorId === agentId && event.authorKind === 'agent' &&
      event.kind === 'message' && !event.voided)
    .sort((a, b) => b.seq - a.seq)[0]
  if (previous && !isPassiveReply(agentId, previous.sourceEventId, events)) {
    return { allowed: false, mode: 'proactive', reason: 'consecutive_proactive' }
  }
  return { allowed: true, mode: 'proactive' }
}

export function blockedSpeechNotice(title: string, reason: AgentSpeechBlockReason): string {
  const detail = reason === 'consecutive_proactive'
    ? '连续主动发言限制；等待该 Agent 被人类 @ 后重置'
    : '该 Agent 当前仅允许被人类 @ 后回复'
  return `${title}：尝试主动发言，但是被拦截（${detail}）。`
}
