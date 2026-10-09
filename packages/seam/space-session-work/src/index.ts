import { Service } from 'cordis'
import type { Context } from 'cordis'

export interface SessionWorkState {
  activeSessionId: string | null
  owners: string[]
  queue: Array<{ sessionId: string; owner: string; position: number }>
}

declare module 'cordis' {
  interface Context { sessionWork: SessionWorkService }
  interface Events { 'session-work/changed'(this: Context, state: SessionWorkState): void }
}

/** Shared session gate. Different same-session owners may overlap; one logical owner and one session are cross-process exclusive. */
export abstract class SessionWorkService extends Service {
  constructor(ctx: Context) { super(ctx, 'sessionWork') }
  abstract tryEnter(sessionId: string, owner: string): boolean
  abstract leave(sessionId: string, owner: string): void
  abstract cancelQueued(sessionId: string, owner: string): void
  abstract state(): SessionWorkState
}
