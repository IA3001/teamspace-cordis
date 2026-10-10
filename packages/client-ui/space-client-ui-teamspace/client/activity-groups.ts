export interface ActivityEventLike {
  id: string
  seq: number
  kind: string
  authorId: string | null
  text: string
  ts: string
  voided?: boolean
}

export interface ActivityGroup<T extends ActivityEventLike> {
  event: T
  count: number
}

/** Collapse adjacent duplicate system notices in a newest-first activity list. */
export function groupActivityEvents<T extends ActivityEventLike>(
  events: readonly T[], windowMs = 60_000,
): ActivityGroup<T>[] {
  const groups: ActivityGroup<T>[] = []
  for (const event of events) {
    const previous = groups.at(-1)
    const elapsed = previous ? Math.abs(Date.parse(previous.event.ts) - Date.parse(event.ts)) : Infinity
    if (previous && event.kind === 'system' && event.authorId === null && !event.voided &&
      previous.event.kind === 'system' && previous.event.authorId === null && !previous.event.voided &&
      previous.event.text === event.text && Number.isFinite(elapsed) && elapsed <= windowMs) {
      previous.count++
    } else {
      groups.push({ event, count: 1 })
    }
  }
  return groups
}
