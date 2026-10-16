import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
const publishName = `qa-workspace-publish-${randomUUID()}`
const personalProjectPath = `projects/${publishName}/hello-cordis`
const sharedProjectPath = resolve(process.cwd(), 'data/shared-workspace', personalProjectPath)
const approvalDb = new DatabaseSync(':memory:')
approvalDb.exec(readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0023_sandbox_approval_requests.up.sql'), 'utf8'))
approvalDb.exec(readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0031_sandbox_approval_claim.up.sql'), 'utf8'))
const upgradeDb = new DatabaseSync(':memory:')
upgradeDb.exec(readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0023_sandbox_approval_requests.up.sql'), 'utf8'))
upgradeDb.prepare(`INSERT INTO sandbox_approval_requests
  (id, agent_id, session_id, source_path, source_size, source_mtime_ms, source_ctime_ms, source_inode,
   reason, status, created_at, decision_note)
  VALUES ('sar_legacy', 'agent-legacy', 'session-legacy', '/tmp/legacy.txt', 7, 1, 2, 3,
   'legacy request', 'pending', '2026-10-01T00:00:00.000Z', 'legacy note')`).run()
upgradeDb.exec(readFileSync(resolve(process.cwd(), 'packages/impl/space-store-sqlite/migrations/0031_sandbox_approval_claim.up.sql'), 'utf8'))
assert.equal(JSON.stringify(upgradeDb.prepare('SELECT id, status, decision_note FROM sandbox_approval_requests').get()),
  JSON.stringify({ id: 'sar_legacy', status: 'pending', decision_note: 'legacy note' }), 'schema upgrade preserves existing approval rows')
upgradeDb.close()
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
  const tools = new ToolRegistry(ctx, { allow: ['tool.workspace.read', 'tool.workspace.write', 'tool.workspace.publish', 'tool.code.execute'] })
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
  const unorganizedWrite = await tools.invoke('tool.workspace.write', JSON.stringify({ path: 'loose.md', content: 'should be rejected' }), invoker)
  assert.equal(unorganizedWrite.ok, false, 'workspace writes must follow the standard directory layout')
  assert.match(unorganizedWrite.output, /工作区目录规范/u)
  await tools.invoke('tool.workspace.write', JSON.stringify({ path: 'notes/result.txt', content: 'personal data' }), invoker)
  const personal = await tools.invoke('tool.workspace.read', JSON.stringify({ path: 'notes/result.txt' }), invoker)
  assert.equal(personal.ok, true)
  assert.equal(personal.output, 'personal data')

  await tools.invoke('tool.workspace.write', JSON.stringify({
    path: `${personalProjectPath}/src/main.cpp`, content: '#include <iostream>\nint main() { std::cout << "hello cordis"; }\n',
  }), invoker)
  await tools.invoke('tool.workspace.write', JSON.stringify({
    path: `${personalProjectPath}/README.md`, content: '# Hello Cordis\nA multi-file shared project.\n',
  }), invoker)
  const published = await tools.invoke('tool.workspace.publish', JSON.stringify({ path: personalProjectPath }), invoker)
  assert.equal(published.ok, true, published.output)
  assert.match(published.output, /2 个文件/u, 'publishing reports the complete project file count')
  assert.equal(readFileSync(join(sharedProjectPath, 'src/main.cpp'), 'utf8'), '#include <iostream>\nint main() { std::cout << "hello cordis"; }\n')
  assert.equal(readFileSync(join(sharedProjectPath, 'README.md'), 'utf8'), '# Hello Cordis\nA multi-file shared project.\n')
  assert.equal(tools.list().some((tool) => tool.id === 'tool.workspace.publish'), true, 'publish is exposed through the tool catalog')
  const concurrentSource = `${personalProjectPath}/concurrent`
  await tools.invoke('tool.workspace.write', JSON.stringify({ path: `${concurrentSource}/src/a.ts`, content: 'export const a = 1\n' }), invoker)
  await tools.invoke('tool.workspace.write', JSON.stringify({ path: `${concurrentSource}/README.md`, content: 'concurrent publication\n' }), invoker)
  const concurrentTarget = `${personalProjectPath}-concurrent`
  const concurrentPublishes = await Promise.all([1, 2].map(() => tools.invoke('tool.workspace.publish', JSON.stringify({
    path: concurrentSource, targetPath: concurrentTarget,
  }), invoker)))
  assert.equal(concurrentPublishes.filter((result) => result.ok).length, 1,
    'concurrent publishers serialize on the target and exactly one publication succeeds')
  assert.equal(readFileSync(resolve(process.cwd(), 'data/shared-workspace', concurrentTarget, 'src/a.ts'), 'utf8'),
    'export const a = 1\n', 'the winning concurrent publication is complete')
  const publishConflict = await tools.invoke('tool.workspace.publish', JSON.stringify({ path: personalProjectPath }), invoker)
  assert.equal(publishConflict.ok, false, 'publishing to an existing shared target is rejected')
  assert.match(publishConflict.output, /已存在，拒绝覆盖/u)
  assert.equal(readFileSync(join(sharedProjectPath, 'src/main.cpp'), 'utf8').includes('hello cordis'), true,
    'a conflicting publish leaves the original shared project intact')
  const otherId = 'a_sandbox_publish_reader'
  agents.register({ id: otherId, kind: 'custom', title: '共享工程读取验收 Agent', capabilities: [] })
  await workdir.claim(otherId)
  const sharedProjectRead = await tools.invoke('tool.workspace.read', JSON.stringify({
    path: `${personalProjectPath}/src/main.cpp`, scope: 'shared',
  }), { id: otherId, sessionId: invoker.sessionId })
  assert.equal(sharedProjectRead.ok, true, sharedProjectRead.output)
  assert.match(sharedProjectRead.output, /hello cordis/u, 'another Agent reads the published source only through shared scope')
  const personalIsolation = await tools.invoke('tool.workspace.read', JSON.stringify({ path: `${personalProjectPath}/src/main.cpp` }), {
    id: otherId, sessionId: invoker.sessionId,
  })
  assert.equal(personalIsolation.ok, false, 'the reader still cannot read the publisher personal workspace')
  const invalidPublishRoot = await tools.invoke('tool.workspace.publish', JSON.stringify({ path: 'notes' }), invoker)
  assert.equal(invalidPublishRoot.ok, false, 'publishing is restricted to organized project directories')

  const linkPath = join((await workdir.claim(invoker.id)).root, personalProjectPath, 'linked-secret')
  symlinkSync(join(outside, 'secret.txt'), linkPath)
  const linkedTarget = `${personalProjectPath}-symlink-check`
  const linkedPublish = await tools.invoke('tool.workspace.publish', JSON.stringify({ path: personalProjectPath, targetPath: linkedTarget }), invoker)
  assert.equal(linkedPublish.ok, false, 'project publication rejects symlinks instead of copying their targets')
  assert.match(linkedPublish.output, /符号链接/u)
  assert.equal(statSync(resolve(process.cwd(), 'data/shared-workspace', linkedTarget), { throwIfNoEntry: false }), undefined,
    'a failed publication never leaves a partially readable target')
  rmSync(linkPath, { force: true })
  writeFileSync(join((await workdir.claim(invoker.id)).root, personalProjectPath, 'oversized.bin'), Buffer.alloc(1024 * 1024 + 1))
  const oversizedPublish = await tools.invoke('tool.workspace.publish', JSON.stringify({
    path: personalProjectPath, targetPath: `${personalProjectPath}-size-check`,
  }), invoker)
  assert.equal(oversizedPublish.ok, false, 'publication enforces the per-file byte limit even for files created outside the write tool')
  assert.match(oversizedPublish.output, /超过 1048576 字节上限/u)

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
  assert.match(approvalNeeded.output, /批准后请重试相同读取/u)
  const pending = ctx.sandboxApproval.list('pending')[0]!
  approvalDir = resolve(process.cwd(), 'data/shared-workspace/approvals', pending.id)
  mkdirSync(approvalDir, { recursive: true })
  const staleTemp = join(approvalDir, `.delivery-${pending.id}-${randomUUID()}.tmp`)
  writeFileSync(staleTemp, 'partial interrupted copy', { mode: 0o000 })
  assert.equal(statSync(staleTemp).mode & 0o777, 0, 'incomplete staging files are unreadable')
  const sandboxTempRead = await tools.invoke('tool.code.execute', JSON.stringify({
    code: `await import('node:fs/promises').then(fs => fs.readFile('/shared/approvals/${pending.id}/${staleTemp.split('/').at(-1)}'))`,
  }), invoker)
  assert.equal(sandboxTempRead.ok, false, 'the unprivileged sandbox cannot read an interrupted approval temp')
  assert.match(sandboxTempRead.output, /EACCES|permission denied/u)
  const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(staleTemp, staleAt, staleAt)
  assert.equal(pending.agentId, invoker.id)
  assert.equal(pending.sessionId, invoker.sessionId)
  const repeatedPending = ctx.sandboxApproval.request({
    agentId: pending.agentId, sessionId: pending.sessionId ?? undefined, sourcePath: pending.sourcePath,
    sourceSize: pending.sourceSize, sourceMtimeMs: pending.sourceMtimeMs,
    sourceCtimeMs: pending.sourceCtimeMs, sourceInode: pending.sourceInode,
  })
  assert.equal(repeatedPending.id, pending.id, 'repeated tool calls reuse one pending review request')
  const claimed = ctx.sandboxApproval.beginApproval(pending.id, 'admin-test', '已检查并复制')
  assert.equal(claimed.status, 'approving', 'approval claims the request before any file delivery begins')
  assert.throws(() => ctx.sandboxApproval.decide(pending.id, 'rejected', 'admin-race', '并发拒绝'), /已处理或不存在/u,
    'a rejection cannot race past an approval already delivering')
  const delivered = await ctx.sandboxApprovalDelivery.deliver(pending)
  assert.equal(readdirSync(approvalDir).some((name) => name.startsWith('.delivery-')), false,
    'retry removes an old interrupted temp copy')
  assert.equal(ctx.sandboxApproval.get(pending.id).status, 'approving', 'an interrupted delivery remains resumable')
  const approvedFile = resolve(process.cwd(), 'data/shared-workspace', delivered.relativePath)
  assert.equal(statSync(approvedFile).mode & 0o777, 0o400, 'published file is read-only')
  assert.deepEqual(await ctx.sandboxApprovalDelivery.deliver(pending), delivered,
    'retry after a completed copy but before the decision record reuses the verified file')
  chmodSync(approvedFile, 0o600)
  writeFileSync(approvedFile, 'tampered destination')
  await assert.rejects(ctx.sandboxApprovalDelivery.deliver(pending), /内容不匹配/,
    'retry refuses to overwrite a destination that no longer matches the reviewed source')
  assert.equal(readdirSync(approvalDir).some((name) => name.startsWith('.delivery-')), false,
    'failed retries remove their own temporary copy')
  writeFileSync(approvedFile, 'admin approved content')
  chmodSync(approvedFile, 0o400)
  const approved = ctx.sandboxApproval.decide(pending.id, 'approved', 'admin-test', '已检查并复制', delivered.relativePath)
  assert.equal(approved.status, 'approved')
  const approvedRead = await tools.invoke('tool.workspace.read', JSON.stringify({ path: delivered.relativePath, scope: 'shared' }), invoker)
  assert.equal(approvedRead.output, 'admin approved content')
  const approvedRetry = await tools.invoke('tool.workspace.read', JSON.stringify({ path: join(outside, 'approved.txt') }), invoker)
  assert.equal(approvedRetry.ok, true, 'retrying the original boundary-crossing request resolves its approved shared copy')
  assert.equal(approvedRetry.output, 'admin approved content', 'approved retries do not require relaying the shared path')
  agents.register({ id: 'a_other_sandbox_verify', kind: 'custom', title: '其他验收 Agent', capabilities: [] })
  const crossAgentRetry = await tools.invoke('tool.workspace.read', JSON.stringify({ path: join(outside, 'approved.txt') }), {
    id: 'a_other_sandbox_verify', sessionId: invoker.sessionId,
  })
  assert.equal(crossAgentRetry.ok, false, 'another Agent cannot reuse the approved copy')
  assert.equal(ctx.sandboxApproval.list('pending').some((item) => item.agentId === 'a_other_sandbox_verify'), true,
    'approval lookup is scoped to the requesting Agent')
  const crossSessionRetry = await tools.invoke('tool.workspace.read', JSON.stringify({ path: join(outside, 'approved.txt') }), {
    id: invoker.id, sessionId: 's_another_session',
  })
  assert.equal(crossSessionRetry.ok, false, 'the same Agent cannot reuse approval from another session')
  assert.equal(ctx.sandboxApproval.list('pending').some((item) => item.agentId === invoker.id && item.sessionId === 's_another_session'), true,
    'approval lookup is scoped to the requesting session')
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
  const unorganizedExecution = await tools.invoke('tool.code.execute', JSON.stringify({ code: 'console.log("should not run")', filename: 'loose.mjs' }), invoker)
  assert.equal(unorganizedExecution.ok, false, 'code execution files must be placed in an organized workspace directory')
  assert.match(unorganizedExecution.output, /工作区目录规范/u)
  const sandboxUid = await tools.invoke('tool.code.execute', JSON.stringify({ code: 'console.log(process.getuid())' }), invoker)
  assert.equal(sandboxUid.ok, true, sandboxUid.output)
  assert.match(sandboxUid.output, new RegExp(String(typeof process.getuid === 'function' ? process.getuid() : 1000), 'u'),
    'code execution uses the service account UID rather than container root')
  const protectedWrite = await tools.invoke('tool.code.execute', JSON.stringify({
    code: `await import('node:fs/promises').then(fs => fs.writeFile('/shared/${sharedFile}', 'changed'))`,
  }), invoker)
  assert.equal(protectedWrite.ok, false, 'container cannot write the team-shared mount')

  rmSync(sharedPath, { force: true })
  rmSync(sharedProjectPath, { recursive: true, force: true })
  rmSync(resolve(process.cwd(), 'data/shared-workspace', `${personalProjectPath}-concurrent`), { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log('✓ workspace boundaries, multi-file Agent publication/readback, conflict and size limits, symlink checks, Docker limits, atomic approval delivery, and read-only shared mount passed')
}

try {
  await main()
} finally {
  rmSync(sharedPath, { force: true })
  rmSync(sharedProjectPath, { recursive: true, force: true })
  rmSync(resolve(process.cwd(), 'data/shared-workspace', `${personalProjectPath}-concurrent`), { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  if (approvalDir) rmSync(approvalDir, { recursive: true, force: true })
  approvalDb.close()
}
