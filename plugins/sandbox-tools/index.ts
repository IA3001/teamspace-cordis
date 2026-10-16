import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { SandboxApprovalDeliveryService } from 'space-sandbox-approval'
import type { SandboxApprovalRequest } from 'space-sandbox-approval'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024
const MAX_CODE_BYTES = 128 * 1024
const MAX_PUBLISH_FILES = 200
const MAX_PUBLISH_BYTES = 10 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000
const SHARED_ROOT = resolve(process.cwd(), 'data/shared-workspace')
const PUBLISH_STAGING_ROOT = resolve(process.cwd(), 'data/.shared-workspace-staging')
const STALE_DELIVERY_TEMP_MS = 60 * 60 * 1000
const STALE_PUBLISH_LOCK_MS = 30 * 60 * 1000

export const name = 'sandbox-tools'
export const inject = ['tools', 'workdir', 'sandboxApproval', 'eventLog']

class SharedApprovalDelivery extends SandboxApprovalDeliveryService {
  async deliver(request: SandboxApprovalRequest): Promise<{ relativePath: string }> {
    if (!/^sar_[a-f0-9-]{36}$/u.test(request.id)) throw new Error('审批请求 ID 无效')
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
      // Temps stay hidden and unreadable while being written. A same-filesystem
      // hard link publishes a complete file atomically without replacing a path.
      const tempPrefix = `.delivery-${request.id}-`
      for (const name of await readdir(folder)) {
        if (!name.startsWith(tempPrefix) || !name.endsWith('.tmp')) continue
        const stalePath = resolve(folder, name)
        try {
          const stale = await lstat(stalePath)
          if (stale.isFile() && Date.now() - stale.mtimeMs > STALE_DELIVERY_TEMP_MS) await unlink(stalePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const tempPath = resolve(folder, `${tempPrefix}${randomUUID()}.tmp`)
      let output
      try {
        output = await open(tempPath, 'wx', 0o000)
        await output.writeFile(content)
        await output.sync()
        await output.chmod(0o400)
        await output.sync()
      } finally { await output?.close() }
      try {
        await link(tempPath, destination)
        const directory = await open(folder, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A retry after publication may find the canonical path already present.
        // Reuse it only when it exactly matches the reviewed source.
        const existing = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const existingInfo = await existing.stat()
          const existingContent = await existing.readFile()
          if (!existingInfo.isFile() || existingInfo.size !== content.byteLength || !existingContent.equals(content)) {
            throw new Error('审批交付路径已存在且内容不匹配，拒绝覆盖')
          }
        } finally { await existing.close() }
      } finally {
        try { await unlink(tempPath) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
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

function assertOrganizedWorkspacePath(root: string, target: string, allowedTopLevel: string[], rootFiles: string[] = []): string {
  const localPath = relative(root, target)
  const segments = localPath.split(/[\\/]/u).filter(Boolean)
  if (segments.length === 1 && rootFiles.includes(segments[0]!)) return localPath
  if (segments.length < 2 || !allowedTopLevel.includes(segments[0]!)) {
    throw new Error(`请按工作区目录规范保存文件：项目放 projects/<名称>/，任务放 tasks/<任务>/，脚本放 scripts/，笔记放 notes/；根目录仅允许 ${rootFiles.join('、') || '不允许文件'}`)
  }
  return localPath
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

function assertWorkspaceRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('path 必须是工作区内不含 . 或 .. 段的相对路径')
  }
  return value
}

async function snapshotProject(sourceRoot: string): Promise<Array<{ relativePath: string; content: Buffer }>> {
  const files: Array<{ relativePath: string; content: Buffer }> = []
  let totalBytes = 0
  async function walk(directory: string, prefix: string): Promise<void> {
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('工程目录包含符号链接或非普通目录，拒绝发布')
    await realPathWithin(sourceRoot, directory)
    const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('工程包含无效文件名，拒绝发布')
      const fullPath = resolve(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const before = await lstat(fullPath)
      if (before.isSymbolicLink()) throw new Error(`工程包含符号链接 ${relativePath}，拒绝发布`)
      if (before.isDirectory()) {
        await walk(fullPath, relativePath)
        continue
      }
      if (!before.isFile()) throw new Error(`工程包含非普通文件 ${relativePath}，拒绝发布`)
      if (before.size > MAX_FILE_BYTES) throw new Error(`文件 ${relativePath} 超过 ${MAX_FILE_BYTES} 字节上限`)
      if (files.length >= MAX_PUBLISH_FILES) throw new Error(`工程文件数超过 ${MAX_PUBLISH_FILES} 个上限`)
      const source = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let content: Buffer
      try {
        const opened = await source.stat()
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
          throw new Error(`文件 ${relativePath} 在读取前发生变化，请重试发布`)
        }
        content = await source.readFile()
        const after = await source.stat()
        if (content.byteLength !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new Error(`文件 ${relativePath} 在读取期间发生变化，请重试发布`)
        }
      } finally { await source.close() }
      totalBytes += content.byteLength
      if (totalBytes > MAX_PUBLISH_BYTES) throw new Error(`工程总大小超过 ${MAX_PUBLISH_BYTES} 字节上限`)
      files.push({ relativePath, content })
    }
  }
  await walk(sourceRoot, '')
  if (!files.length) throw new Error('工程目录中没有可发布的普通文件')
  return files
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  const segments = rel.split(/[\\/]/u).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('共享区目标路径包含符号链接，拒绝发布')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
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
  await Promise.all(['approvals', 'projects', 'docs', 'resources'].map((folder) =>
    mkdir(resolve(SHARED_ROOT, folder), { recursive: true })))
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
        const approved = ctx.sandboxApproval.list('approved').find((item) =>
          item.agentId === invoker.id && item.sessionId === (invoker.sessionId ?? null) && item.sourcePath === requested,
        )
        if (approved?.deliveryPath) {
          const deliveredPath = await realPathWithin(SHARED_ROOT, within(SHARED_ROOT, approved.deliveryPath))
          const deliveredInfo = await stat(deliveredPath)
          if (!deliveredInfo.isFile() || deliveredInfo.size > MAX_FILE_BYTES) {
            throw new Error('已批准的共享区副本不存在、类型无效或超过读取上限')
          }
          return await readFile(deliveredPath, 'utf8')
        }
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
        throw new Error(`路径越出工作区边界，已提交后台管理员审批（请求 ${request.id}）。批准后请重试相同读取；系统会直接读取已交付的共享区副本。`)
      }
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`文件不存在或超过读取上限 ${MAX_FILE_BYTES} 字节`)
      return await readFile(path, 'utf8')
    },
  })

  ctx.tools.register({
    id: 'tool.workspace.write', title: '写入个人工作区文件', description: 'args: {"path":"相对路径","content":"文本"}；只写个人工作区。根目录保持整洁：项目放 projects/<项目名>/{src,tests,docs}，任务材料放 tasks/<任务目录>，脚本放 scripts/，笔记放 notes/。', capabilities: ['workspace.write'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ path?: string; content?: string }>(raw)
      const content = String(args.content ?? '')
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`写入内容超过 ${MAX_FILE_BYTES} 字节上限`)
      const root = (await claimWorkdir(ctx, invoker)).root
      assertActive(invoker)
      const path = within(root, String(args.path ?? ''))
      assertOrganizedWorkspacePath(root, path, ['projects', 'tasks', 'scripts', 'notes'], ['README.md', 'AGENTS.md'])
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
    id: 'tool.workspace.publish', title: '发布个人工程到团队共享工作区',
    description: `args: {"path":"个人工作区内 projects/ 下的工程目录","targetPath":"可选共享区 projects/ 下目标目录"}；复制完整多文件工程到团队共享区。单文件最多 ${MAX_FILE_BYTES} 字节，最多 ${MAX_PUBLISH_FILES} 个文件、总计 ${MAX_PUBLISH_BYTES} 字节；拒绝符号链接、特殊文件和目标冲突，不覆盖已有内容。`,
    capabilities: ['workspace.publish'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ path?: string; targetPath?: string }>(raw)
      const sourceRelative = assertWorkspaceRelativePath(String(args.path ?? ''))
      if (!sourceRelative.startsWith('projects/') || sourceRelative.split('/').length < 2) {
        throw new Error('只允许发布个人工作区 projects/ 下的完整工程目录')
      }
      const targetRelative = assertWorkspaceRelativePath(String(args.targetPath ?? sourceRelative))
      if (!targetRelative.startsWith('projects/') || targetRelative.split('/').length < 2) {
        throw new Error('共享区目标必须位于 projects/ 下')
      }
      const personal = (await claimWorkdir(ctx, invoker)).root
      const sourcePath = within(personal, sourceRelative)
      const sourceReal = await realPathWithin(personal, sourcePath)
      const sourceInfo = await lstat(sourcePath)
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error('path 必须指向个人工作区内的普通工程目录')
      const snapshot = await snapshotProject(sourceReal)
      assertActive(invoker)

      const destination = within(SHARED_ROOT, targetRelative)
      const parent = dirname(destination)
      await mkdir(parent, { recursive: true })
      await assertNoSymlinkAncestors(SHARED_ROOT, parent)
      await realPathWithin(SHARED_ROOT, parent)
      await mkdir(PUBLISH_STAGING_ROOT, { recursive: true })
      const [sharedInfo, stageInfo] = await Promise.all([stat(SHARED_ROOT), stat(PUBLISH_STAGING_ROOT)])
      if (sharedInfo.dev !== stageInfo.dev) throw new Error('共享区暂存目录与目标不在同一文件系统，无法保证原子发布')
      const lockPath = resolve(PUBLISH_STAGING_ROOT,
        `target-${createHash('sha256').update(targetRelative).digest('hex')}.lock`)
      let lock
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const stale = await stat(lockPath).catch(() => null)
        if (stale && Date.now() - stale.mtimeMs > STALE_PUBLISH_LOCK_MS) {
          await unlink(lockPath).catch(() => {})
          try { lock = await open(lockPath, 'wx', 0o600) }
          catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') throw retryError
          }
        }
        if (!lock) throw new Error(`共享区目标 ${targetRelative} 正在被另一个发布请求处理，请稍后重试`)
      }
      const stage = resolve(PUBLISH_STAGING_ROOT, `publish-${randomUUID()}`)
      try {
        try {
          await lstat(destination)
          throw new Error(`共享区目标 ${targetRelative} 已存在，拒绝覆盖`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await mkdir(stage, { mode: 0o700 })
        try {
          for (const file of snapshot) {
            assertActive(invoker)
            const outputPath = within(stage, file.relativePath)
            await mkdir(dirname(outputPath), { recursive: true })
            await writeFile(outputPath, file.content, { flag: 'wx', mode: 0o644 })
          }
          assertActive(invoker)
          // Readers see either no target or the complete directory tree.
          try {
            await rename(stage, destination)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
              throw new Error(`共享区目标 ${targetRelative} 已存在，拒绝覆盖`)
            }
            throw error
          }
        } finally {
          await rm(stage, { recursive: true, force: true }).catch(() => {})
        }
      } finally {
        await lock.close()
        await unlink(lockPath).catch(() => {})
      }
      const totalBytes = snapshot.reduce((total, file) => total + file.content.byteLength, 0)
      ctx.logger.info('[workspace-publish] agent=%s session=%s source=%s target=%s files=%d bytes=%d',
        invoker.id, invoker.sessionId ?? '', sourceRelative, targetRelative, snapshot.length, totalBytes)
      return `已原子发布 ${snapshot.length} 个文件（${totalBytes} 字节）到团队共享工作区 ${targetRelative}。其他 Agent 可使用 tool.workspace.read 并设置 scope="shared" 读取。`
    },
  })

  ctx.tools.register({
    id: 'tool.code.execute', title: '在隔离容器中执行 Node.js', description: 'args: {"code":"Node.js ES module 源码","filename":"可选相对路径 .mjs"}；默认写入 scripts/，容器可联网，个人区可读写，共享区只读。', capabilities: ['code.execute', 'network'],
    handler: async (raw, invoker) => {
      assertActive(invoker)
      const args = parseArgs<{ code?: string; filename?: string }>(raw)
      const code = String(args.code ?? '')
      if (!code.trim()) throw new Error('code 不能为空')
      if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new Error(`代码超过 ${MAX_CODE_BYTES} 字节上限`)
      const root = (await claimWorkdir(ctx, invoker)).root
      assertActive(invoker)
      const filename = String(args.filename ?? `scripts/sandbox-${randomUUID()}.mjs`)
      if (isAbsolute(filename) || filename.includes('\\') || !filename.endsWith('.mjs') ||
        filename.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('filename 必须是工作区内不含 . 或 .. 段的相对 .mjs 路径')
      }
      const scriptPath = within(root, filename)
      const scriptRelativePath = assertOrganizedWorkspacePath(root, scriptPath, ['scripts', 'projects', 'tasks'])
      try {
        await mkdir(dirname(scriptPath), { recursive: true })
        await realPathWithin(root, dirname(scriptPath))
        await writeFile(scriptPath, code, { encoding: 'utf8', flag: 'wx' })
      }
      catch (error) { reportQuotaFailure(ctx, invoker, error); throw error }
      assertActive(invoker)
      try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
        const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
        const result = await execFileAsync('docker', [
          'run', '--rm', '--user', `${uid}:${gid}`, '--network=bridge', '--memory=512m', '--cpus=0.75', '--pids-limit=64',
          '--storage-opt', 'size=256m', '--ulimit', 'fsize=67108864:67108864',
          '--read-only', '--tmpfs', '/tmp:rw,exec,size=64m',
          '--mount', `type=bind,src=${root},dst=/workspace`,
          '--mount', `type=bind,src=${SHARED_ROOT},dst=/shared,readonly`,
          '--workdir', '/workspace', 'node:22-alpine', 'node', `/workspace/${scriptRelativePath}`,
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
