import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context { sandboxApproval: SandboxApprovalService }
}

export type SandboxApprovalStatus = 'pending' | 'approved' | 'rejected'
export interface SandboxApprovalRequest {
  id: string
  agentId: string
  sessionId: string | null
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  sourceCtimeMs: number
  sourceInode: number
  reason: string
  status: SandboxApprovalStatus
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  decisionNote: string
  deliveryPath: string | null
}

declare module 'cordis' { interface Context { sandboxApprovalDelivery: SandboxApprovalDeliveryService } }

export abstract class SandboxApprovalService extends Service {
  constructor(ctx: Context) { super(ctx, 'sandboxApproval') }
  abstract request(input: { agentId: string; sessionId?: string; sourcePath: string; sourceSize: number; sourceMtimeMs: number; sourceCtimeMs: number; sourceInode: number; reason?: string }): SandboxApprovalRequest
  abstract get(id: string): SandboxApprovalRequest
  abstract list(status?: SandboxApprovalStatus): SandboxApprovalRequest[]
  abstract decide(id: string, decision: 'approved' | 'rejected', adminId: string, note: string, deliveryPath?: string): SandboxApprovalRequest
}

/** Trusted host-side adapter: copies one reviewed regular file into the read-only shared area. */
export abstract class SandboxApprovalDeliveryService extends Service {
  constructor(ctx: Context) { super(ctx, 'sandboxApprovalDelivery') }
  abstract deliver(request: SandboxApprovalRequest): Promise<{ relativePath: string }>
}
