export const MAX_PROGRESS_PREVIEW_CHARACTERS = 16_000

export type ProgressPreviewPhase = 'started' | 'preparing' | 'assembling-context' | 'waiting-model' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta' | 'finalizing' | 'completed' | 'failed' | 'cancelled'

const TERMINAL_PROGRESS_PHASES = new Set<ProgressPreviewPhase>(['completed', 'failed', 'cancelled'])

export interface ProgressTimelineEvent {
  id: string
  sessionId?: string
  authorId?: string | null
  authorKind?: string
  kind?: string
  sourceEventId?: string | null
  sourceEventIds?: string[]
  toolCalls?: Array<{ name: string; args: string }>
}

export interface AnchoredProgressRun {
  sessionId: string
  agentId: string
  sourceEventId: string | null
}

function eventReferencesRun(event: ProgressTimelineEvent, run: AnchoredProgressRun): boolean {
  // Context citations are not task triggers; one reply can cite earlier runs.
  return Boolean(run.sourceEventId && event.sourceEventId === run.sourceEventId &&
    (event.kind === undefined || event.kind === 'message'))
}

export function progressRunHasReply(run: AnchoredProgressRun, events: readonly ProgressTimelineEvent[]): boolean {
  return Boolean(run.sourceEventId && events.some((event) => event.sessionId === run.sessionId &&
    event.authorKind === 'agent' && event.authorId === run.agentId && eventReferencesRun(event, run)))
}

/** A completed draft can be rejected by speech policy instead of becoming a reply. */
export function progressRunHasOutcome(run: AnchoredProgressRun, events: readonly ProgressTimelineEvent[]): boolean {
  if (progressRunHasReply(run, events)) return true
  return Boolean(run.sourceEventId && events.some((event) => event.sessionId === run.sessionId &&
    event.sourceEventId === run.sourceEventId && event.authorKind === 'system' && event.kind === 'system' &&
    event.toolCalls?.some((call) => {
      if (call.name !== 'agent.reply.outcome') return false
      try {
        const result = JSON.parse(call.args)
        return result?.agentId === run.agentId && result.status === 'blocked'
      } catch { return false }
    })))
}

/** Attach a run to its trigger message until its Agent reply appears, then move it to that reply. */
export function progressRunsForTimelineEvent<T extends AnchoredProgressRun>(
  event: ProgressTimelineEvent,
  events: readonly ProgressTimelineEvent[],
  runs: readonly T[],
): T[] {
  return runs.filter((run) => {
    if (run.sessionId !== event.sessionId || !run.sourceEventId) return false
    if (event.authorKind === 'agent' && event.authorId === run.agentId && eventReferencesRun(event, run)) return true
    if (event.id !== run.sourceEventId) return false
    return !progressRunHasReply(run, events)
  })
}

/** Only unanchored runs need a standalone fallback row. */
export function progressRunHasTimelineAnchor(
  run: AnchoredProgressRun,
  events: readonly ProgressTimelineEvent[],
): boolean {
  return Boolean(run.sourceEventId && events.some((event) => event.sessionId === run.sessionId &&
    event.id === run.sourceEventId) || progressRunHasReply(run, events))
}

/**
 * Session ownership can briefly disappear while the orchestrator hands work
 * between owners. Keep the UI busy while its own Agent run or reply is live.
 */
export function isSessionReplyActive(input: {
  sessionId: string
  activeSessionId?: string | null
  runs: Array<{ sessionId?: string; phase: ProgressPreviewPhase }>
  pendingSessionIds?: string[]
}): boolean {
  return input.activeSessionId === input.sessionId ||
    input.runs.some((run) => run.sessionId === input.sessionId && !TERMINAL_PROGRESS_PHASES.has(run.phase)) ||
    Boolean(input.pendingSessionIds?.includes(input.sessionId))
}

export function settlesPendingReply(event: {
  sourceEventId?: string | null
  authorKind?: string
  kind?: string
}): boolean {
  return Boolean(event.sourceEventId) && (event.authorKind === 'agent' || event.kind === 'system')
}

export const SOCKET_SILENCE_WARNING_MS = 45_000

export function shouldWarnAboutSocketSilence(input: {
  now: number
  lastActivityAt: number
  hasAgentWork: boolean
  pageVisible: boolean
  socketOpen: boolean
  state: string
}): boolean {
  return input.socketOpen && input.pageVisible && input.hasAgentWork && input.state === 'online' &&
    input.now - input.lastActivityAt >= SOCKET_SILENCE_WARNING_MS
}

export interface ProgressPreview {
  text: string
  totalCharacters: number
  truncated: boolean
}

export function appendProgressDelta(previous: ProgressPreview, delta: string): ProgressPreview {
  const previousCharacters = Array.from(previous.text)
  const nextCharacters = Array.from(delta)
  const totalCharacters = previous.totalCharacters + nextCharacters.length
  const combined = [...previousCharacters, ...nextCharacters]
  return {
    text: combined.slice(-MAX_PROGRESS_PREVIEW_CHARACTERS).join(''),
    totalCharacters,
    truncated: previous.truncated || totalCharacters > MAX_PROGRESS_PREVIEW_CHARACTERS,
  }
}

export function progressPreviewLabel(
  phase: ProgressPreviewPhase,
  preview: Pick<ProgressPreview, 'text' | 'totalCharacters' | 'truncated'>,
): string {
  const state = phase === 'failed' ? '任务失败（未提交回复草稿）'
    : phase === 'cancelled' ? '任务已撤回（未提交回复草稿）'
      : phase === 'completed' ? '回复流已完成（预览）'
        : phase === 'finalizing' ? '回复已生成，正在保存产物'
          : '回复草稿（生成中）'
  if (!preview.truncated) return state
  const shownCharacters = Array.from(preview.text).length
  return `${state}（仅显示末尾 ${shownCharacters}/${preview.totalCharacters} 字符）`
}
