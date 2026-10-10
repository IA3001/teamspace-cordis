import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from 'cordis'
import { DatabaseSync } from 'node:sqlite'
import { AgentRegistry } from '../plugins/agent-registry/index.ts'
import { ToolRegistry } from '../plugins/space-tool/index.ts'
import { LocalWorkdirService } from '../packages/impl/space-workdir-local/src/index.ts'
import { apply as applySandboxTools } from '../plugins/sandbox-tools/index.ts'
import { SqliteSandboxApproval } from '../packages/impl/space-store-sqlite/src/sandbox-approval.ts'
import { EventLogService } from 'space-event'
import type { EventInput, ReactSummary, SessionEvent } from 'space-event'

const sandbox = mkdtempSync(join(tmpdir(), 'teamspace-sandbox-'))
const outside = mkdtempSync(join(tmpdir(), 'teamspace-sandbox-outside-'))
const sharedFile = `sandbox-verify-${randomUUID()}.txt`
const sharedPath = resolve(process.cwd(), 'data/shared-workspace', sharedFile)
const approvalDb = new DatabaseSync(':memory:')
approvalDb.exec(readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0023_sandbox_approval_requests.up.sql'), 'utf8'))
let approvalDir: string | undefined

class VerifyEventLog extends EventLogService {
  readonly events: SessionEvent[] = []
  append(input: EventInput): SessionEvent {
    const event = { ...input, seq: this.events.length + 1, ts: input.ts ?? new Date().toISOString(), voided: false,
      voidedBy: null, voidedAt: null, voidedReason: null, sourceEventId: input.sourceEventId ?? null,
      sourceEventIds: input.sourceEventIds ?? [] } as SessionEvent
    this.events.push(event)
    return event
  }
  void(_id: string, _by: string, _reason: string): number { return 0 }
  listBySession(sessionId: string): SessionEvent[] { return this.events.filter((event) => event.sessionId === sessionId) }
  lastSeq(sessionId: string): number { return this.listBySession(sessionId).at(-1)?.seq ?? 0 }
  search(_sessionId: string, _query: string): SessionEvent[] { return [] }
  async react(_eventId: string, _userId: string, _emoji: string): Promise<ReactSummary[]> { return [] }
  async unreact(_eventId: string, _userId: string, _emoji: string): Promise<ReactSummary[]> { return [] }
  async reactions(_eventIds: string[]): Promise<Record<string, ReactSummary[]>> { return {} }
}

async function main(): Promise<void> {
  const ctx = new Context()
  const agents = new AgentRegistry(ctx)
  agents.register({ id: 'a_sandbox_verify', kind: 'custom', title: '沙箱验收 Agent', capabilities: [] })
  const workdir = new LocalWorkdirService(ctx, sandbox)
  const eventLog = new VerifyEventLog(ctx)
  const tools = new ToolRegistry(ctx, { allow: ['tool.workspace.read', 'tool.workspace.write', 'tool.code.execute'] })
  new SqliteSandboxApproval(ctx, approvalDb)
  await applySandboxTools(ctx)
  await workdir.claim('a_sandbox_verify')

  const invoker = { id: 'a_sandbox_verify', sessionId: 's_sandbox_verify' }

  const originalClaim = workdir.claim.bind(workdir)
  workdir.claim = async (agentId) => { throw Object.assign(new Error('simulated quota setup failure'), { code: 'quota_unavailable' }) }
  const quotaFailure = await tools.invoke('tool.workspace.read', JSON.stringify({ path: 'blocked.txt' }), invoker)
  assert.equal(quotaFailure.ok, false)
  assert.match(eventLog.listBySession(invoker.sessionId).at(-1)?.text ?? '', /宿主机磁盘配额/)
  workdir.claim = originalClaim
  await tools.invoke('tool.workspace.write', JSON.stringify({ path: 'notes/result.txt', content: 'personal data' }), invoker)
  const personal = await tools.invoke('tool.workspace.read', JSON.stringify({ path: 'notes/result.txt' }), invoker)
  assert.equal(personal.ok, true)
  assert.equal(personal.output, 'personal data')

  writeFileSync(sharedPath, 'shared read only')
  const shared = await tools.invoke('tool.workspace.read', JSON.stringify({ path: sharedFile, scope: 'shared' }), invoker)
  assert.equal(shared.output, 'shared read only')
  const escaped = await tools.invoke('tool.workspace.read', JSON.stringify({ path: '../outside.txt' }), invoker)
  assert.equal(escaped.ok, false, 'lexical path traversal is rejected')
  writeFileSync(join(outside, 'approved.txt'), 'admin approved content')
  const approvalNeeded = await tools.invoke('tool.workspace.read', JSON.stringify({
    path: join(outside, 'approved.txt'), reason: '需要读取用户批准的输入文件',
  }), invoker)
  assert.equal(approvalNeeded.ok, false)
  assert.match(approvalNeeded.output, /已提交后台管理员审批/)
  const pending = ctx.sandboxApproval.list('pending')[0]!
  approvalDir = resolve(process.cwd(), 'data/shared-workspace/approvals', pending.id)
  assert.equal(pending.agentId, invoker.id)
  assert.equal(pending.sessionId, invoker.sessionId)
  const repeatedPending = ctx.sandboxApproval.request({
    agentId: pending.agentId, sessionId: pending.sessionId ?? undefined, sourcePath: pending.sourcePath,
    sourceSize: pending.sourceSize, sourceMtimeMs: pending.sourceMtimeMs,
    sourceCtimeMs: pending.sourceCtimeMs, sourceInode: pending.sourceInode,
  })
  assert.equal(repeatedPending.id, pending.id, 'repeated tool calls reuse one pending review request')
  const delivered = await ctx.sandboxApprovalDelivery.deliver(pending)
  assert.equal(ctx.sandboxApproval.get(pending.id).status, 'pending', 'copying alone does not commit the decision')
  assert.deepEqual(await ctx.sandboxApprovalDelivery.deliver(pending), delivered,
    'retry after a completed copy but before the decision record reuses the verified file')
  const approvedFile = resolve(process.cwd(), 'data/shared-workspace', delivered.relativePath)
  writeFileSync(approvedFile, 'tampered destination')
  await assert.rejects(ctx.sandboxApprovalDelivery.deliver(pending), /内容不匹配/,
    'retry refuses to overwrite a destination that no longer matches the reviewed source')
  writeFileSync(approvedFile, 'admin approved content')
  const approved = ctx.sandboxApproval.decide(pending.id, 'approved', 'admin-test', '已检查并复制', delivered.relativePath)
  assert.equal(approved.status, 'approved')
  const approvedRead = await tools.invoke('tool.workspace.read', JSON.stringify({ path: delivered.relativePath, scope: 'shared' }), invoker)
  assert.equal(approvedRead.output, 'admin approved content')
  const duplicate = ctx.sandboxApproval.request({
    agentId: invoker.id, sessionId: invoker.sessionId, sourcePath: join(outside, 'approved.txt'),
    sourceSize: pending.sourceSize, sourceMtimeMs: pending.sourceMtimeMs,
    sourceCtimeMs: pending.sourceCtimeMs, sourceInode: pending.sourceInode,
  })
  assert.notEqual(duplicate.id, pending.id, 'resolved requests do not prevent a later fresh request')
  const linkedPath = join((await workdir.claim(invoker.id)).root, 'outside-link')
  writeFileSync(join(outside, 'secret.txt'), 'host secret')
  symlinkSync(outside, linkedPath, 'dir')
  const symlinkEscape = await tools.invoke('tool.workspace.read', JSON.stringify({ path: 'outside-link/secret.txt' }), invoker)
  assert.equal(symlinkEscape.ok, false, 'symlink traversal outside the workdir is rejected')

  const executed = await tools.invoke('tool.code.execute', JSON.stringify({ code: 'console.log("sandbox-ok")' }), invoker)
  assert.equal(executed.ok, true, executed.output)
  assert.match(executed.output, /sandbox-ok/)
  const protectedWrite = await tools.invoke('tool.code.execute', JSON.stringify({
    code: `await import('node:fs/promises').then(fs => fs.writeFile('/shared/${sharedFile}', 'changed'))`,
  }), invoker)
  assert.equal(protectedWrite.ok, false, 'container cannot write the team-shared mount')

  rmSync(sharedPath, { force: true })
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log('✓ workspace read/write boundaries, symlink escape checks, Docker limits, and read-only shared mount passed')
}

try {
  await main()
} finally {
  rmSync(sharedPath, { force: true })
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  if (approvalDir) rmSync(approvalDir, { recursive: true, force: true })
  approvalDb.close()
}
