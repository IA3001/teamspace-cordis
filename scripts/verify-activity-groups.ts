import assert from 'node:assert/strict'
import { groupActivityEvents } from '../packages/client-ui/space-client-ui-teamspace/client/activity-groups.ts'

const event = (seq: number, kind: string, authorId: string | null, text: string, ts: number) => ({
  id: `event-${seq}`, seq, kind, authorId, text, ts: new Date(ts).toISOString(),
})
const source = [
  event(8, 'system', null, '任务正在等待前序处理', 80_000),
  event(7, 'system', null, '任务正在等待前序处理', 79_900),
  event(6, 'message', 'human-1', '请继续', 79_800),
  event(5, 'system', null, '任务正在等待前序处理', 79_700),
  event(4, 'system', null, '任务正在等待前序处理', 10_000),
  event(3, 'system', null, '任务正在等待前序处理', 9_900, ),
  event(2, 'message', 'human-1', '重复文本', 9_800),
  event(1, 'message', 'human-1', '重复文本', 9_700),
]
const grouped = groupActivityEvents(source)
assert.deepEqual(grouped.map(({ event: item, count }) => [item.seq, count]), [
  [8, 2], [6, 1], [5, 1], [4, 2], [2, 1], [1, 1],
])
assert.equal(grouped[0]?.event.id, 'event-8', 'group links to the newest original event')
assert.equal(source.length, 8, 'grouping does not mutate or remove the source timeline')
console.log('✓ Activity grouping collapses only adjacent duplicate system notices and preserves original events')
