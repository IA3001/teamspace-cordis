import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { MemoryItem } from 'space-memory'
import type { SessionEvent } from 'space-event'

declare module 'cordis' {
  interface Context {
    agentInbox: AgentInboxService
  }
}

/** Ordered background ingestion of a session event stream for one invited Agent. */
export abstract class AgentInboxService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentInbox')
  }

  /** Wait until background ingestion has durably advanced through seq when a caller needs it. */
  abstract waitThrough(agentId: string, sessionId: string, seq: number): Promise<void>

  /** Return the durable per-Agent cursor for a session (0 means no history consumed). */
  abstract cursor(agentId: string, sessionId: string): Promise<number>

  /** Live, human-readable background history ingestion status by Agent. */
  abstract processing(): AgentInboxProcessing[]

  /** Current session whose invited Agents are consuming events. */
  abstract activeSessionId(): string | null

  /** Rebuild one invalidated mixed-source memory using only its surviving source events. */
  abstract rebuildInvalidatedMemory(item: MemoryItem, validSources: SessionEvent[]): Promise<number>
}

export interface AgentInboxProcessing {
  agentId: string
  sessionId: string
  seq: number
  eventId: string
  phase: 'reviewing-decision' | 'extracting-memory' | 'advancing-cursor' | 'failed'
  detail: string
  startedAt: string
  updatedAt: string
}
