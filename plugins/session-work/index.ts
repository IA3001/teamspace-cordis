import type { Context } from 'cordis'
import { SessionWorkService } from 'space-session-work'
import type { SessionWorkState } from 'space-session-work'

export const name = 'session-work'

export class SessionWork extends SessionWorkService {
  private activeSessionId: string | null = null
  private readonly owners = new Set<string>()
  private readonly queued = new Map<string, Set<string>>()

  tryEnter(sessionId: string, owner: string): boolean {
    if (!sessionId.trim() || !owner.trim()) return false
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      const waiters = this.queued.get(sessionId) ?? new Set<string>()
      waiters.add(owner)
      this.queued.set(sessionId, waiters)
      this.publish()
      return false
    }
    const wasQueued = this.queued.get(sessionId)?.delete(owner) ?? false
    if (this.queued.get(sessionId)?.size === 0) this.queued.delete(sessionId)
    this.activeSessionId = sessionId
    this.owners.add(owner)
    if (wasQueued || this.owners.size === 1) this.publish()
    return true
  }

  leave(sessionId: string, owner: string): void {
    if (this.activeSessionId !== sessionId || !this.owners.delete(owner)) return
    if (this.owners.size === 0) this.activeSessionId = null
    this.publish()
  }

  cancelQueued(sessionId: string, owner: string): void {
    const waiters = this.queued.get(sessionId)
    if (!waiters?.delete(owner)) return
    if (waiters.size === 0) this.queued.delete(sessionId)
    this.publish()
  }

  state(): SessionWorkState {
    const queue = [...this.queued.entries()]
      .flatMap(([sessionId, owners]) => [...owners].map((owner) => ({ sessionId, owner })))
      .map((item, index) => ({ ...item, position: index + 1 }))
    return { activeSessionId: this.activeSessionId, owners: [...this.owners], queue }
  }

  private publish(): void { this.ctx.emit('session-work/changed', this.state()) }
}

export function apply(ctx: Context) { new SessionWork(ctx) }
