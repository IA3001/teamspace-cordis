/** User-facing fallback for transport/runtime exceptions; never render raw exception text. */
export function userFacingFailure(action: string): string {
  const label = action.trim() || '操作'
  return `${label}失败，请检查网络后重试；若问题持续，请联系系统管理员。`
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  await_human: '等待团队成员下一步指示',
  await_human_decision: '等待 DRI 决策',
  completed: '本轮处理已完成',
  budget_exhausted: '本轮自动处理已到上限，请人工决定下一步',
  invalid_target: '请求的协作对象不可用，已暂停',
  coordinator_unconfigured: '协作模型尚未配置，请联系系统管理员',
  coordinator_error: '模型暂时无法完成请求，请联系系统管理员检查配置',
  coordinator_empty: '模型没有返回内容，请重试或联系系统管理员',
  duplicate_target: '重复任务已拦截，等待下一步',
  agent_target_unknown: '目标 Agent 当前不可用，请联系系统管理员检查团队配置',
}

/** Render a known, actionable pause description; never expose internal reason codes. */
export function userFacingPause(reason: string): string {
  return PAUSE_REASON_LABELS[reason] ?? '处理已安全暂停，请联系系统管理员。'
}
