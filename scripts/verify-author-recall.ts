import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { SessionEvent } from 'space-event'
import { invalidateRecallConsequences } from '../plugins/staging-commands/index.ts'

const event = (id: string, seq: number, authorId: string, authorKind: 'human' | 'agent', sourceEventIds: string[] = []): SessionEvent => ({
  id, seq, sessionId: 's_recall', phaseId: null, ts: new Date().toISOString(), authorId, authorKind,
  kind: 'message', text: id, mentions: [], toolCalls: [], replyMode: '', sourceEventId: sourceEventIds[0] ?? null,
  sourceEventIds, voided: false, voidedBy: null, voidedAt: null, voidedReason: null,
})

const target = event('human-source', 1, 'u_author', 'human')
const safeSource = event('safe-source', 2, 'u_other', 'human')
const direct = event('agent-direct', 3, 'a_one', 'agent', [target.id])
const second = event('agent-second', 4, 'a_two', 'agent', [direct.id])
const events = [target, safeSource, direct, second]
const cancelled: string[] = []
const voided: string[] = []
const rebuiltSources: string[][] = []
let insertedLate = false
const memoryItems = [
  { id: 'm-direct', scope: 'agent:a_one', kind: 'fact', text: '撤回来源', sourceEventIds: [target.id], sourceEventId: target.id },
  { id: 'm-mixed', scope: 'agent:a_one', kind: 'fact', text: '混合来源', sourceEventIds: [target.id, safeSource.id], sourceEventId: target.id },
  { id: 'm-downstream', scope: 'agent:a_two', kind: 'fact', text: '派生来源', sourceEventIds: [second.id], sourceEventId: second.id },
]
const ctx = Object.assign(new Context(), {
  eventLog: {
    listBySession: () => [...events].sort((a, b) => a.seq - b.seq),
    void(id: string, by: string, reason: string) {
      const item = events.find((row) => row.id === id)!
      if (item.voided) return 0
      item.voided = true; item.voidedBy = by; item.voidedReason = reason; voided.push(id)
      return 1
    },
  },
  session: { listMembers: () => [{ principalId: 'a_one' }, { principalId: 'a_two' }] },
  agents: { get: (id: string) => ({ descriptor: { id } }) },
  agentRuntime: { async cancelBySource(id: string) { cancelled.push(id); return 0 } },
  orchestrator: { cancelDelegationsBySource(_sessionId: string, id: string) { cancelled.push(id); return [] } },
  agentInbox: {
    async waitThrough(_agentId: string, _sessionId: string, _seq: number) {
      if (!insertedLate) {
        insertedLate = true
        events.push(event('agent-late', 5, 'a_two', 'agent', [direct.id]))
      }
    },
    async rebuildInvalidatedMemory(_item: unknown, sources: SessionEvent[]) {
      rebuiltSources.push(sources.map((source) => source.id)); return 1
    },
  },
  memory: {
    async invalidateBySource(id: string) {
      return memoryItems.filter((item) => item.sourceEventIds.includes(id))
    },
  },
  logger: { warn() {} },
}) as unknown as Context

const result = await invalidateRecallConsequences(ctx, 's_recall', target, 'u_author')
assert.deepEqual(new Set(voided), new Set(['human-source', 'agent-direct', 'agent-second', 'agent-late']))
assert.equal(safeSource.voided, false, 'an unrelated human message survives the recall')
assert.ok(cancelled.includes(target.id) && cancelled.includes(direct.id) && cancelled.includes('agent-late'),
  'active runs and delegation ledgers are cancelled for each causal source')
assert.equal(result.voided, 4)
assert.equal(result.invalidated, 3, 'source memories and the mixed-source audit snapshot are invalidated')
assert.equal(result.rebuilt, 1)
assert.deepEqual(rebuiltSources, [[safeSource.id]], 'mixed memory is rebuilt only from the surviving source')
console.log('✓ Author recall cancels and voids the causal chain, drains late replies, and rebuilds surviving mixed memory')
