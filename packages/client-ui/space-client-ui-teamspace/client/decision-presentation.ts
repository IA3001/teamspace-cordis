export interface DecisionEventLike {
  id: string
  kind: string
  authorKind: string
  text: string
  replyTo?: string | null
  seq?: number
}

export interface DecisionPresentation {
  recommendation: string
  question: string
  title: string
  type: 'warning' | 'success' | 'error' | 'info'
}

const MARKER = '【需要DRI决策】'

/** Turn the Agent's explicit decision marker into a concise, linked UI notice. */
export function decisionPresentation<T extends DecisionEventLike>(
  event: T,
  timeline: readonly DecisionEventLike[],
): DecisionPresentation | null {
  if (event.kind !== 'message' || event.authorKind !== 'agent' || !event.text.includes(MARKER)) return null
  const [recommendation = '', question = ''] = event.text.split(MARKER, 2)
  const latestDecision = timeline
    .filter((item) => item.replyTo === event.id && (item.kind === 'approval' || item.kind === 'decision') &&
      item.text.startsWith('DRI 决策：'))
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0]
  const label = latestDecision?.text.match(/^DRI 决策：([^\n]+)/)?.[1]
  const latestReview = timeline
    .filter((item) => item.replyTo === event.id && item.kind === 'decision' &&
      item.text.startsWith('【撤回复核请求】'))
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0]
  const reviewCompleted = Boolean(latestReview && timeline.some((item) =>
    item.replyTo === latestReview.id && item.kind === 'system' && item.text.startsWith('【复核完成】')))
  const reviewIsCurrent = Boolean(latestReview && (latestDecision?.seq ?? 0) < (latestReview.seq ?? 0))
  if (reviewIsCurrent) return {
    recommendation: recommendation.trim(), question: question.trim() || '阅读复核意见后，再次执行固定决策命令定案。',
    title: reviewCompleted
      ? label === '暂缓' ? '复核完成，待 DRI 再次决策' : '复核完成，待 DRI 定案'
      : '正在收集复核意见',
    type: reviewCompleted ? 'info' : 'warning',
  }
  if (!label) return {
    recommendation: recommendation.trim(), question: question.trim() || '请审阅建议并使用固定决策命令。',
    title: '待 DRI 决策', type: 'warning',
  }
  if (label === '暂缓') return {
    recommendation: recommendation.trim(), question: question.trim() || '等待复核完成后再次作出决定。',
    title: reviewCompleted ? '复核完成，待 DRI 再次决策' : '已暂缓，等待复核',
    type: reviewCompleted ? 'info' : 'warning',
  }
  const type = label === '通过' ? 'success' : label === '否决' || label === '撤回' ? 'error' : 'info'
  return {
    recommendation: recommendation.trim(), question: question.trim() || `DRI 已${label}此建议。`,
    title: `DRI 已${label}`, type,
  }
}
