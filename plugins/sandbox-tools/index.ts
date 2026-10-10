import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { SandboxApprovalDeliveryService } from 'space-sandbox-approval'
import type { SandboxApprovalRequest } from 'space-sandbox-approval'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024
const MAX_CODE_BYTES = 128 * 1024
const MAX_OUTPUT_CHARS = 16_000
const SHARED_ROOT = resolve(process.cwd(), 'data/shared-workspace')

export const name = 'sandbox-tools'
export const inject = ['tools', 'workdir', 'sandboxApproval', 'eventLog']

class SharedApprovalDelivery extends SandboxApprovalDeliveryService {
  async deliver(request: SandboxApprovalRequest): Promise<{ relativePath: string }> {
    const source = await open(request.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`只允许批准不超过 ${MAX_FILE_BYTES} 字节的普通文件`)
      if (info.size !== request.sourceSize || info.mtimeMs !== request.sourceMtimeMs || info.ctimeMs !== request.sourceCtimeMs || info.ino !== request.sourceInode) {
        throw new Error('申请文件自管理员审查后已发生变化，请重新申请')
      }
      const content = await source.readFile()
      const afterRead = await source.stat()
      if (content.byteLength !== info.size || afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs ||
        afterRead.ctimeMs !== info.ctimeMs || afterRead.ino !== info.ino) {
        throw new Error('源文件在审批交付期间发生变化，请重新申请')
      }
      const leaf = basename(request.sourcePath).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120) || 'approved-file'
      const folder = resolve(SHARED_ROOT, 'approvals', request.id)
      await mkdir(folder, { recursive: true })
      const destination = resolve(folder, leaf)
      let output
      try { output = await open(destination, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A process may stop after publishing the copy but before committing the
        // approval row. Let an Admin retry only when the existing regular file
        // is exactly the reviewed source; never overwrite an unrelated path.
        const existing = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const existingInfo = await existing.stat()
          const existingContent = await existing.readFile()
          if (!existingInfo.isFile() || existingInfo.size !== content.byteLength || !existingContent.equals(content)) {
            throw new Error('审批交付路径已存在且内容不匹配，拒绝覆盖')
          }
        } finally { await existing.close() }
        return { relativePath: `approvals/${request.id}/${leaf}` }
      }
      try { await output.writeFile(content); await output.sync() } finally { await output.close() }
      return { relativePath: `approvals/${request.id}/${leaf}` }
    } finally { await source.close() }
  }
}

function within(root: string, input: string): string {
  const target = resolve(root, input || '.')
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('路径越出工作区边界')
  }
  return target
}

async function realPathWithin(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root)
  const realTarget = await realpath(target)
  const rel = relative(realRoot, realTarget)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('符号链接目标越出工作区边界')
  }
  return realTarget
}

function parseArgs<T extends Record<string, unknown>>(raw: string): T {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是 JSON 对象')
  return value as T
}

function assertActive(invoker: { signal?: AbortSignal }): void {
  if (invoker.signal?.aborted) throw new Error('Agent 任务已撤回，工具调用已取消')
}

function isQuotaFailure(error: unknown): boolean {
  const value = error as { code?: string; message?: string; stderr?: string }
  return value?.code === 'quota_unavailable' || /EDQUOT|ENOSPC|EFBIG|disk quota exceeded|no space left on device/i.test(
    `${value?.message ?? ''}\n${value?.stderr ?? ''}`,
  )
}

function reportQuotaFailure(ctx: Context, invoker: { id: string; sessionId?: string }, error: unknown): void {
  if (!isQuotaFailure(error)) return
  const message = `Agent ${invoker.id} 的个人工作区达到或无法登记宿主机磁盘配额，相关操作已停止。请联系后台管理员检查工作区配额。`
  ctx.logger.error('[workdir-quota] session=%s agent=%s error=%s', invoker.sessionId, invoker.id,
    error instanceof Error ? error.message : String(error))
  try {
    if (!invoker.sessionId) return
    ctx.eventLog.append({
      id: randomUUID(), sessionId: invoker.sessionId, authorId: null, phaseId: null,
      authorKind: 'system', kind: 'system', text: message,
      mentions: [], toolCalls: [], replyMode: '',
    })
  } catch (eventError) {
    ctx.logger.error('[workdir-quota] alert append failed (session=%s): %s', invoker.sessionId,
      eventError instanceof Error ? eventError.message : String(eventError))
  }
}

async function claimWorkdir(ctx: Context, invoker: { id: string; sessionId?: string }) {
  try { return await ctx.workdir.claim(invoker.id) }
  catch (error) { reportQuotaFailure(ctx, invoker, error); throw error }
}

export async function apply(ctx: Context) {
  await mkdir(SHARED_ROOT, { recursive: true })
  new SharedApprovalDelivery(ctx)
  ctx.tools.register({
    id: 'tool.workspace.read', title: '读取工作区文件', description: 'args: {"path":"相对路径","scope":"personal|shared"}；shared 只读。', capabilities: ['workspace.read'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ path?: string; scope?: string; reason?: string }>(raw)
      const scope = args.scope === 'shared' ? 'shared' : 'personal'
      const root = scope === 'shared' ? SHARED_ROOT : (await claimWorkdir(ctx, invoker)).root
      assertActive(invoker)
      let path: string
      try {
        path = await realPathWithin(root, within(root, String(args.path ?? '')))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (!detail.includes('越出工作区边界')) throw error
        const requested = resolve(root, String(args.path ?? ''))
        const requestedInfo = await lstat(requested).catch(() => null)
        if (!requestedInfo?.isFile() || requestedInfo.isSymbolicLink() || requestedInfo.size > MAX_FILE_BYTES) {
          throw new Error('路径越出工作区边界；仅普通文件可提交后台审批，且文件大小不得超过 1 MB')
        }
        const request = ctx.sandboxApproval.request({
          agentId: invoker.id, sessionId: invoker.sessionId, sourcePath: requested,
          sourceSize: requestedInfo.size, sourceMtimeMs: requestedInfo.mtimeMs,
          sourceCtimeMs: requestedInfo.ctimeMs, sourceInode: requestedInfo.ino,
          reason: String(args.reason ?? '').slice(0, 1000),
        })
        throw new Error(`路径越出工作区边界，已提交后台管理员审批（请求 ${request.id}）。管理员决定后，请团队成员告知是否获批及共享区路径。`)
      }
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`文件不存在或超过读取上限 ${MAX_FILE_BYTES} 字节`)
      return await readFile(path, 'utf8')
    },
  })

  ctx.tools.register({
    id: 'tool.workspace.write', title: '写入个人工作区文件', description: 'args: {"path":"相对路径","content":"文本"}；只写个人工作区。', capabilities: ['workspace.write'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ path?: string; content?: string }>(raw)
      const content = String(args.content ?? '')
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`写入内容超过 ${MAX_FILE_BYTES} 字节上限`)
      const root = (await claimWorkdir(ctx, invoker)).root
      assertActive(invoker)
      const path = within(root, String(args.path ?? ''))
      try {
        await mkdir(dirname(path), { recursive: true })
        await realPathWithin(root, dirname(path))
        assertActive(invoker)
        try {
          if ((await lstat(path)).isSymbolicLink()) throw new Error('拒绝覆盖符号链接')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await writeFile(path, content, 'utf8')
      } catch (error) {
        reportQuotaFailure(ctx, invoker, error)
        throw error
      }
      return `已写入 ${relative(root, path)}（${Buffer.byteLength(content)} 字节）`
    },
  })

  ctx.tools.register({
    id: 'tool.code.execute', title: '在隔离容器中执行 Node.js', description: 'args: {"code":"Node.js ES module 源码","filename":"可选 .mjs 名称"}；容器可联网，个人区可读写，共享区只读。', capabilities: ['code.execute', 'network'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ code?: string; filename?: string }>(raw)
      const code = String(args.code ?? '')
      if (!code.trim()) throw new Error('code 不能为空')
      if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new Error(`代码超过 ${MAX_CODE_BYTES} 字节上限`)
      const root = (await claimWorkdir(ctx, invoker)).root
      assertActive(invoker)
      const filename = String(args.filename ?? `sandbox-${randomUUID()}.mjs`)
      if (basename(filename) !== filename || !filename.endsWith('.mjs')) throw new Error('filename 必须是工作区内的 .mjs 文件名')
      const scriptPath = within(root, filename)
      try { await writeFile(scriptPath, code, { encoding: 'utf8', flag: 'wx' }) }
      catch (error) { reportQuotaFailure(ctx, invoker, error); throw error }
      assertActive(invoker)
      try {
        const result = await execFileAsync('docker', [
          'run', '--rm', '--network=bridge', '--memory=512m', '--cpus=0.75', '--pids-limit=64',
          '--storage-opt', 'size=256m', '--ulimit', 'fsize=67108864:67108864',
          '--read-only', '--tmpfs', '/tmp:rw,exec,size=64m',
          '--mount', `type=bind,src=${root},dst=/workspace`,
          '--mount', `type=bind,src=${SHARED_ROOT},dst=/shared,readonly`,
          '--workdir', '/workspace', 'node:22-alpine', 'node', `/workspace/${filename}`,
        ], { timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true, signal: invoker.signal })
        const output = `${result.stdout}${result.stderr}`.slice(0, MAX_OUTPUT_CHARS)
        return output || '执行完成（无标准输出）'
      } catch (error) {
        reportQuotaFailure(ctx, invoker, error)
        const commandError = error as Error & { stdout?: string; stderr?: string; killed?: boolean }
        const output = `${commandError.stdout ?? ''}${commandError.stderr ?? ''}`.slice(0, MAX_OUTPUT_CHARS)
        throw new Error(`${commandError.killed ? '执行超时（45 秒）' : commandError.message}${output ? `\n${output}` : ''}`)
      }
    },
  })
}
