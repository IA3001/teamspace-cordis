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

export interface DecisionAccessContext {
  viewerIsDri: boolean
  viewerRole?: string
  driName?: string
  driPrincipalId?: string
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
    recommendation: recommendation.trim(), question: question.trim() || '阅读复核意见后，再次从回复卡片提交决策。',
    title: reviewCompleted
      ? label === '暂缓' ? '复核完成，待 DRI 再次决策' : '复核完成，待 DRI 定案'
      : '正在收集复核意见',
    type: reviewCompleted ? 'info' : 'warning',
  }
  if (!label) return {
    recommendation: recommendation.trim(), question: question.trim() || '请审阅建议，并使用下方操作按钮处理。',
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

/** Explain why decision controls are or are not available, and point to their location. */
export function decisionAccessGuidance(context: DecisionAccessContext): string {
  if (context.viewerIsDri) {
    return '当前登录账号是本会话 DRI；请在这张 Agent 回复卡片下方选择「通过」或「其他处理」。消息「⋯」菜单里没有决策入口。'
  }
  if (context.driName) {
    const identity = context.driPrincipalId ? `（${context.driPrincipalId}）` : ''
    const roleHelp = context.viewerRole === '群主'
      ? '你可以从会话「⋯」→「成员 / 角色管理」将其他人类成员设为 DRI；群主角色固定，不能把自己改成 DRI。'
      : '请使用这个 DRI 账号登录，或请群主从会话「⋯」→「成员 / 角色管理」指定人类成员为 DRI。'
    return `当前登录账号无通过权限。请使用 DRI「${context.driName}」${identity}登录；只有该 DRI 能在 Agent 回复卡片下方选择「通过」或「其他处理」，消息「⋯」菜单没有决策入口。${roleHelp}`
  }
  if (context.viewerRole === '群主') {
    return '当前登录账号无通过权限，且本会话还没有 DRI。请从会话「⋯」→「成员 / 角色管理」将其他人类成员设为 DRI；群主角色固定，不能把自己改成 DRI。'
  }
  return '当前登录账号无通过权限，且本会话还没有 DRI。请使用群主指定的 DRI 账号登录；或请群主从会话「⋯」→「成员 / 角色管理」指定人类成员为 DRI。'
}
