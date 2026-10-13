export interface FailureNotice {
  id: number
  message: string
}

/** Preserve distinct failures until a person dismisses them; collapse repeated identical errors. */
export function appendFailureNotice(
  notices: FailureNotice[],
  notice: FailureNotice,
): FailureNotice[] {
  if (notices.some((current) => current.message === notice.message)) return notices
  return [...notices, notice]
}

export function dismissFailureNotice(notices: FailureNotice[], id: number): FailureNotice[] {
  return notices.filter((notice) => notice.id !== id)
}
