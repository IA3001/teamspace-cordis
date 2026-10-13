export const MAX_PROGRESS_PREVIEW_CHARACTERS = 16_000

export type ProgressPreviewPhase = 'started' | 'preparing' | 'assembling-context' | 'waiting-model' | 'processing' | 'tool-start' | 'tool-finish' | 'text-delta' | 'finalizing' | 'completed' | 'failed' | 'cancelled'

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
