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

  /** Ensure all eligible events through seq have been ingested before an @ reply. */
  abstract waitThrough(agentId: string, sessionId: string, seq: number): Promise<void>

  /** Return the durable per-Agent cursor for a session (0 means no history consumed). */
  abstract cursor(agentId: string, sessionId: string): Promise<number>

  /** Current session whose invited Agents are consuming events. */
  abstract activeSessionId(): string | null

  /** Rebuild one invalidated mixed-source memory using only its surviving source events. */
  abstract rebuildInvalidatedMemory(item: MemoryItem, validSources: SessionEvent[]): Promise<number>
}
