import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context { adminAuth: AdminAuthService }
}

export interface AdminPrincipal { id: string; username: string }
export interface AdminTokenGrant { token: string; adminId: string; expiresAt: string }
export type AdminAuthErrorCode = 'bad_credentials' | 'token_unknown' | 'token_expired' | 'invalid_bootstrap'

export class AdminAuthError extends Error {
  constructor(public readonly code: AdminAuthErrorCode, message: string) {
    super(message)
    this.name = 'AdminAuthError'
  }
}

/** 后台专用身份和 session 契约；实现不得复用 Team users/login_tokens。 */
export abstract class AdminAuthService extends Service {
  constructor(ctx: Context) { super(ctx, 'adminAuth') }
  abstract configureBootstrap(username: string, password: string): void
  abstract login(username: string, password: string): Promise<AdminTokenGrant>
  abstract verifyToken(token: string): Promise<AdminPrincipal>
  abstract logout(token: string): Promise<void>
}
