import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { AgentInbox } from '../plugins/agent-inbox/index.ts'
import { OrchestratorEngine } from '../plugins/orchestrator/index.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteMemoryStore } from '../packages/impl/space-store-sqlite/src/memory.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { SqliteSessionWork } from '../packages/impl/space-store-sqlite/src/session-work.ts'
import { SqliteSettingsStore } from '../packages/impl/space-store-sqlite/src/settings.ts'

const [dbPath, signalDir, eventId = 'event_mixed'] = process.argv.slice(2)
if (!dbPath || !signalDir) throw new Error('usage: inbox-orchestrator-mix-worker.ts <db-path> <signal-dir> [event-id]')

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
const ctx = new Context() as Context & Record<string, any>
const sessionWork = new SqliteSessionWork(ctx, db, { processId: 'mixed-orchestrator', heartbeatMs: 15 })
new SqliteSessionStore(ctx, db)
const eventLog = new SqliteEventLog(ctx, db)
const memory = new SqliteMemoryStore(ctx, db)
new SqliteSettingsStore(ctx, db)
const agents = new AgentRegistry(ctx)
agents.register({ id: 'a_mixed_worker', kind: 'custom', title: '研究员', capabilities: [], description: '共享 Agent' })
Object.assign(ctx, {
  logger: { error() {}, warn() {}, info() {} },
  llm: {
    configured: true,
    configuredFor: () => true,
    async chat(messages: Array<{ role: string; content: string }>) {
      const input = JSON.parse(messages[1]!.content) as { event?: { id?: string } }
      return JSON.stringify({ memories: input.event?.id === eventId
        ? [{ text: '恢复进程已处理新消息。', weight: 0.9 }]
        : [] })
    },
  },
})
new AgentInbox(ctx)
const engine = new OrchestratorEngine(ctx)
ctx.on('orchestrator/delegate', (payload: { sessionId: string; eventId: string; target: string }) => {
  writeFileSync(`${signalDir}/direct-task-started`, JSON.stringify(payload))
  engine.cancelDelegatedTask(payload.sessionId, payload.target, payload.eventId)
  sessionWork.leave(payload.sessionId, `orchestrator:${payload.sessionId}`)
})
// Production has server handles keeping the process alive; this focused worker
// supplies one so pending cross-process slot waits can be observed faithfully.
const keepAlive = setInterval(() => engine.wakeQueue(), 20)
const event = eventLog.listBySession('s_mixed').find((item) => item.id === eventId)
if (!event) throw new Error('seeded Agent mention event is missing')
writeFileSync(`${signalDir}/orchestrator-ready`, 'ready')
await engine.onPlan({ sessionId: event.sessionId, authorId: event.authorId!, event })
writeFileSync(`${signalDir}/task-dispatched`, 'dispatched')
const latest = eventLog.listBySession(event.sessionId).reduce((max, item) => Math.max(max, item.seq), 0)
await ctx.agentInbox.waitThrough('a_mixed_worker', event.sessionId, latest)
const idleDeadline = Date.now() + 5_000
while (sessionWork.state().activeSessionId && Date.now() < idleDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (sessionWork.state().activeSessionId) throw new Error('Agent Inbox did not release the shared session slot')
writeFileSync(`${signalDir}/orchestrator-finished`, JSON.stringify({ dispatched: true }))
clearInterval(keepAlive)
sessionWork.dispose()
db.close()
