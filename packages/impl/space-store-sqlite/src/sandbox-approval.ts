import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SandboxApprovalService } from 'space-sandbox-approval'
import type { SandboxApprovalRequest, SandboxApprovalStatus } from 'space-sandbox-approval'

type Row = Record<string, unknown>
const now = () => new Date().toISOString()

function fromRow(r: Row): SandboxApprovalRequest {
  return {
    id: String(r.id), agentId: String(r.agent_id), sessionId: r.session_id == null ? null : String(r.session_id),
    sourcePath: String(r.source_path), sourceSize: Number(r.source_size), sourceMtimeMs: Number(r.source_mtime_ms),
    sourceCtimeMs: Number(r.source_ctime_ms), sourceInode: Number(r.source_inode),
    reason: String(r.reason), status: r.status as SandboxApprovalStatus,
    createdAt: String(r.created_at), decidedAt: r.decided_at == null ? null : String(r.decided_at),
    decidedBy: r.decided_by == null ? null : String(r.decided_by), decisionNote: String(r.decision_note ?? ''),
    deliveryPath: r.delivery_path == null ? null : String(r.delivery_path),
  }
}

export class SqliteSandboxApproval extends SandboxApprovalService {
  constructor(ctx: ConstructorParameters<typeof SandboxApprovalService>[0], private readonly db: DatabaseSync) { super(ctx) }

  request(input: { agentId: string; sessionId?: string; sourcePath: string; sourceSize: number; sourceMtimeMs: number; sourceCtimeMs: number; sourceInode: number; reason?: string }): SandboxApprovalRequest {
    const agentId = String(input.agentId).trim()
    const sourcePath = String(input.sourcePath).trim()
    if (!agentId || !sourcePath || sourcePath.length > 2048) throw new Error('审批请求缺少 Agent 或有效路径')
    const existing = this.db.prepare(`SELECT id FROM sandbox_approval_requests WHERE agent_id = ? AND ifnull(session_id, '') = ? AND source_path = ? AND status IN ('pending', 'approving')`).get(agentId, input.sessionId ?? '', sourcePath) as Row | undefined
    if (existing) return this.get(String(existing.id))
    const id = `sar_${randomUUID()}`
    this.db.prepare(`INSERT INTO sandbox_approval_requests(id, agent_id, session_id, source_path, source_size, source_mtime_ms, source_ctime_ms, source_inode, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, agentId, input.sessionId ?? null, sourcePath, input.sourceSize, input.sourceMtimeMs, input.sourceCtimeMs, input.sourceInode, String(input.reason ?? '').slice(0, 1000), now())
    return this.get(id)
  }

  get(id: string): SandboxApprovalRequest {
    const row = this.db.prepare('SELECT * FROM sandbox_approval_requests WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`审批请求 ${id} 不存在`)
    return fromRow(row)
  }

  list(status?: SandboxApprovalStatus): SandboxApprovalRequest[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM sandbox_approval_requests WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM sandbox_approval_requests ORDER BY created_at DESC').all()) as Row[]
    return rows.map(fromRow)
  }

  beginApproval(id: string, adminId: string, note: string): SandboxApprovalRequest {
    const result = this.db.prepare(`UPDATE sandbox_approval_requests SET status = 'approving', decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'`)
      .run(adminId, String(note ?? '').slice(0, 1000), id)
    if (Number(result.changes) !== 1 && this.get(id).status !== 'approving') {
      throw new Error('请求已处理或不存在，请刷新后重试')
    }
    return this.get(id)
  }

  decide(id: string, decision: 'approved' | 'rejected', adminId: string, note: string, deliveryPath?: string): SandboxApprovalRequest {
    const timestamp = now()
    const expected = decision === 'approved' ? 'approving' : 'pending'
    const result = this.db.prepare(`UPDATE sandbox_approval_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, delivery_path = ? WHERE id = ? AND status = ?`)
      .run(decision, timestamp, adminId, String(note ?? '').slice(0, 1000), deliveryPath ?? null, id, expected)
    if (Number(result.changes) !== 1) throw new Error('请求已处理或不存在，请刷新后重试')
    return this.get(id)
  }
}
