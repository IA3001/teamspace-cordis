// space-workdir-local —— space-workdir 缝的本机文件系统后端（P6 收尾，2026-09-30）。
//
// 五语义（seam 契约照表执法）：
//   · claim：先验 agentId 已向 space-agent 缝注册（未知 → not_found —— 工作区
//     只属于入驻的 agent），再幂等领取：已有区原样返回；没有则 mkdir 含父级。
//     root 归属冲突（同一路径被别的 agent 登记）→ already_assigned。
//   · release：删目录（rm -rf 语义）并注销；不存在 → not_found；删除失败
//     → cleanup_failed 带原因。
//   · resolve：拼接 + 归一化后校验仍在 root 内 —— execdir 铁则。用路径边界
//     判定（解析结果必须等于 root 或以 root + 分隔符为前缀），不是字符串
//     startsWith：`/…/root2/x` 不是 `/…/root` 的子路径（第五节红测的靶子）。
//   · get：未领取 → not_found。list：按 agentId 稳定排序。
//
// root 取值与 space-store-sqlite 同源约定：`<cwd>/data/workdirs/<agentId>`
// （store 的库在 <cwd>/data/database.db，工作区并列放 <cwd>/data/workdirs/）。
// agentId 形如 'agent.<名字>'（含点，即 space-agent 的 id 词汇），目录名前先做一层安全替换：
// 非歌词字符（[A-Za-z0-9._-] 之外）一律转 '_'，同 id 恒得同目录名（幂等）。
//
// 依赖方向（lint:deps 断言①）：impl 只准依赖 seams —— 本包依赖
// space-workdir（契约）+ space-agent（入驻名单校验）。
import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, lstat, readdir, readFile, copyFile, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import { WorkdirError, WorkdirService } from 'space-workdir'
import type { WorkdirEntry, WorkdirHandle, WorkdirListing, WorkdirTransferTarget } from 'space-workdir'

const execFileAsync = promisify(execFile)
export interface WorkdirQuotaOptions {
  ensure?: (agentId: string) => Promise<void>
  required?: boolean
}

export class LocalWorkdirService extends WorkdirService {
  /** agentId → handle（进程内台账；目录在磁盘，重启后按需重建台账由 claim 补登）。 */
  private readonly handles = new Map<string, WorkdirHandle>()
  private readonly preparedRoots = new Set<string>()

  constructor(
    ctx: Context,
    private readonly dataDir: string,
    private readonly quota: WorkdirQuotaOptions = {},
  ) {
    super(ctx)
  }

  /** agentId → 安全目录名：非 [A-Za-z0-9._-] 一律转 '_'（同 id 恒得同名）。 */
  private dirNameOf(agentId: string): string {
    return agentId.replace(/[^A-Za-z0-9._-]/g, '_')
  }

  private rootOf(agentId: string): string {
    return join(resolve(this.dataDir), 'workdirs', this.dirNameOf(agentId))
  }

  private sharedRoot(): string {
    return join(resolve(this.dataDir), 'shared-workspace')
  }

  async claim(agentId: string): Promise<WorkdirHandle> {
    // 工作区只属于入驻的 agent（名册制：没向 space-agent 缝报到就没有地盘）。
    try {
      this.ctx.agents.get(agentId)
    } catch {
      throw new WorkdirError('not_found', `agent "${agentId}" 未入驻（先向 space-agent 缝注册才能领取工作区）`)
    }
    const existing = this.handles.get(agentId)
    if (existing) return existing
    const root = this.rootOf(agentId)
    // 归属冲突：同一路径已被别的 agent 登记（正常流不发生 —— dirNameOf 单射；
    // 这道闸是给手工篡改/未来别名机制兜底）。
    for (const [otherId, h] of this.handles) {
      if (otherId !== agentId && h.root === root) {
        throw new WorkdirError('already_assigned', `工作区 ${root} 已被 agent "${otherId}" 占用`)
      }
    }
    const ensureQuota = this.quota.ensure ?? this.helperQuota()
    if (ensureQuota) {
      try { await ensureQuota(agentId) }
      catch (e) {
        throw new WorkdirError('quota_unavailable', `Agent 工作区宿主机配额登记失败：${(e as Error).message}`)
      }
    } else if (this.quota.required ?? process.env.NODE_ENV === 'production') {
      throw new WorkdirError('quota_unavailable', '生产环境未配置工作区配额助手，拒绝创建 Agent 工作区')
    }
    try {
      mkdirSync(root, { recursive: true })
      for (const directory of ['projects', 'tasks', 'scripts', 'notes']) {
        mkdirSync(join(root, directory), { recursive: true })
      }
      this.preparedRoots.add(root)
    } catch (e) {
      throw new WorkdirError('cleanup_failed', `创建工作区目录失败：${(e as Error).message}`)
    }
    const handle: WorkdirHandle = { agentId, root, createdAt: Date.now() }
    this.handles.set(agentId, handle)
    this.ctx.logger.info('[workdir] agent %s 领取工作区 %s', agentId, root)
    return handle
  }

  private helperQuota(): ((agentId: string) => Promise<void>) | undefined {
    const helper = process.env.WORKDIR_QUOTA_HELPER?.trim()
    if (!helper) return undefined
    const sudo = process.env.WORKDIR_QUOTA_SUDO === '1'
    return async (agentId) => {
      const command = sudo ? 'sudo' : helper
      const args = sudo ? ['-n', helper, 'ensure', agentId] : ['ensure', agentId]
      try {
        await execFileAsync(command, args, { timeout: 30_000, windowsHide: true, maxBuffer: 4096 })
      } catch (e) {
        const error = e as Error & { stderr?: string; code?: number | string }
        throw new Error((error.stderr || error.message).trim().slice(0, 500))
      }
    }
  }

  async release(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId)
    if (!handle) {
      throw new WorkdirError('not_found', `agent "${agentId}" 没有已领取的工作区`)
    }
    try {
      rmSync(handle.root, { recursive: true, force: false })
    } catch (e) {
      throw new WorkdirError('cleanup_failed', `清理工作区 ${handle.root} 失败：${(e as Error).message}`)
    }
    this.handles.delete(agentId)
    this.ctx.logger.info('[workdir] agent %s 工作区已清理注销', agentId)
  }

  /** execdir 铁则：归一化后必须等于 root 或位于 root + 分隔符之内（路径边界判定）。
   *  ⚠ WORKDIR_SABOTAGE=1（verify-workdir 红测探针）：走字符串 startsWith 弱
   *  判定 —— 对「../ 逃到 root2 兄弟目录」不报错，A3c 必须判红。这只在验证
   *  脚本显式设该 env 时存在，运行时（不设 env）永远走正确分支。 */
  resolve(agentId: string, relative: string): string {
    const handle = this.get(agentId)
    const root = resolve(handle.root)
    const target = resolve(root, normalize(relative))
    if (process.env.WORKDIR_SABOTAGE === '1') {
      // 弱判定：startsWith 无边界 —— root2/x 会被误判为 root 内（红测靶子）
      if (!target.startsWith(root)) {
        throw new WorkdirError('path_escape', `路径 "${relative}" 解析为 ${target}，逃出工作区 ${root}（execdir 铁则）`)
      }
      return target
    }
    if (target !== root && !target.startsWith(root + sep)) {
      throw new WorkdirError('path_escape', `路径 "${relative}" 解析为 ${target}，逃出工作区 ${root}（execdir 铁则）`)
    }
    return target
  }

  get(agentId: string): WorkdirHandle {
    const handle = this.handles.get(agentId)
    if (!handle) {
      throw new WorkdirError('not_found', `agent "${agentId}" 没有已领取的工作区（先 claim）`)
    }
    return handle
  }

  list(): WorkdirHandle[] {
    return [...this.handles.values()].sort((a, b) => a.agentId.localeCompare(b.agentId))
  }

  private async safeTargetIn(rootPath: string, relativePath = ''): Promise<string> {
    if (relativePath.includes('\\') || relativePath.startsWith('/')) throw new Error('工作区路径必须是相对路径')
    const root = resolve(rootPath)
    const target = resolve(root, normalize(relativePath))
    if (target !== root && !target.startsWith(root + sep)) throw new Error('路径越出工作区边界')
    try {
      const rootInfo = await lstat(root)
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('工作区根目录无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let current = root
    for (const part of relativePath.split('/').filter(Boolean)) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('工作区浏览不跟随符号链接')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    return target
  }

  private async browseRoot(base: string, relativePath = ''): Promise<WorkdirListing> {
    const target = await this.safeTargetIn(base, relativePath)
    try {
      if (!(await lstat(base)).isDirectory()) return { exists: false, path: relativePath, entries: [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, path: relativePath, entries: [] }
      throw error
    }
    let dir
    try { dir = await lstat(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: true, path: relativePath, entries: [] }
      throw error
    }
    if (!dir.isDirectory()) throw new Error('只能浏览工作区目录')
    const hidden = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|id_(?:rsa|ed25519)|credentials?(?:\..*)?|.*(?:secret|token|credential|private[-_]?key).*)$/i
    const rows = await readdir(target, { withFileTypes: true })
    const entries: WorkdirEntry[] = []
    for (const row of rows) {
      if (hidden.test(row.name)) continue
      const childPath = join(target, row.name)
      const info = await lstat(childPath)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue
      const path = relativePath ? `${relativePath}/${row.name}` : row.name
      entries.push({ name: row.name, path, kind: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() })
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
    return { exists: true, path: relativePath, entries: entries.slice(0, 500) }
  }

  async browse(agentId: string, relativePath = ''): Promise<WorkdirListing> {
    const root = this.rootOf(agentId)
    if (!this.preparedRoots.has(root)) {
      try {
        const info = await lstat(root)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工作区根目录无效')
        await Promise.all(['projects', 'tasks', 'scripts', 'notes'].map((directory) => mkdir(join(root, directory), { recursive: true })))
        this.preparedRoots.add(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return this.browseRoot(root, relativePath)
  }

  async browseShared(relativePath = ''): Promise<WorkdirListing> {
    return this.browseRoot(this.sharedRoot(), relativePath)
  }

  private async readTextFromRoot(root: string, relativePath: string): Promise<string> {
    if (!relativePath || relativePath.split('/').some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|id_(?:rsa|ed25519)|credentials?(?:\..*)?|.*(?:secret|token|credential|private[-_]?key).*)$/i.test(part))) {
      throw new Error('该文件类型不允许在工作区浏览器中预览')
    }
    const target = await this.safeTargetIn(root, relativePath)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('仅支持预览普通文件')
    if (info.size > 256 * 1024) throw new Error('文件超过 256 KB，不能在线预览')
    const content = await readFile(target)
    if (content.includes(0)) throw new Error('二进制文件不能在线预览')
    return content.toString('utf8')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
      .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*)["']?[^\s,"'&}]+/gi, '$1[REDACTED]')
  }

  async readText(agentId: string, relativePath: string): Promise<string> {
    return this.readTextFromRoot(this.rootOf(agentId), relativePath)
  }

  async readSharedText(relativePath: string): Promise<string> {
    return this.readTextFromRoot(this.sharedRoot(), relativePath)
  }

  private workspaceFilePath(relativePath: string): void {
    const hidden = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|id_(?:rsa|ed25519)|credentials?(?:\..*)?|.*(?:secret|token|credential|private[-_]?key).*)$/i
    const parts = relativePath.split('/')
    if (!relativePath || relativePath.includes('\\') || parts.some((part) => !part || part === '.' || part === '..' || hidden.test(part))) {
      throw new Error('该文件不能访问，或工作区路径无效')
    }
  }

  private async workspaceRoot(location: WorkdirTransferTarget, create = false): Promise<string> {
    if (location.kind === 'shared') {
      const root = this.sharedRoot()
      if (create) await mkdir(root, { recursive: true })
      return root
    }
    try { this.ctx.agents.get(location.agentId) } catch { throw new WorkdirError('not_found', `Agent "${location.agentId}" 未入驻`) }
    return create ? (await this.claim(location.agentId)).root : this.rootOf(location.agentId)
  }

  async readFile(source: WorkdirTransferTarget, relativePath: string): Promise<Uint8Array> {
    this.workspaceFilePath(relativePath)
    const root = await this.workspaceRoot(source)
    const path = await this.safeTargetIn(root, relativePath)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('只能下载普通文件')
    if (info.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，不能通过工作区下载')
    return await readFile(path)
  }

  async writeFile(target: WorkdirTransferTarget, relativePath: string, content: Uint8Array): Promise<void> {
    this.workspaceFilePath(relativePath)
    if (content.byteLength > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，不能上传到工作区')
    const root = await this.workspaceRoot(target, true)
    let destination = await this.safeTargetIn(root, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    destination = await this.safeTargetIn(root, relativePath)
    try {
      await writeFileAsync(destination, Buffer.from(content), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标工作区已存在同名文件；原文件未覆盖')
      throw error
    }
  }

  async copyFile(sourceLocation: WorkdirTransferTarget, relativePath: string, target: WorkdirTransferTarget): Promise<void> {
    this.workspaceFilePath(relativePath)
    let sourceRoot: string
    if (sourceLocation.kind === 'shared') sourceRoot = this.sharedRoot()
    else {
      try { this.ctx.agents.get(sourceLocation.agentId) } catch { throw new WorkdirError('not_found', `Agent "${sourceLocation.agentId}" 未入驻`) }
      sourceRoot = this.rootOf(sourceLocation.agentId)
    }
    const source = await this.safeTargetIn(sourceRoot, relativePath)
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('只能转发普通文件')
    if (sourceInfo.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，不能通过工作区互传')

    let targetRoot: string
    if (target.kind === 'shared') {
      targetRoot = this.sharedRoot()
      await mkdir(targetRoot, { recursive: true })
    } else {
      try { this.ctx.agents.get(target.agentId) } catch { throw new WorkdirError('not_found', `目标 Agent "${target.agentId}" 未入驻`) }
      targetRoot = (await this.claim(target.agentId)).root
    }
    const destination = await this.safeTargetIn(targetRoot, basename(source))
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标工作区已存在同名文件；原文件未覆盖')
      throw error
    }
  }
}

export interface Config {
  /** 数据目录（工作区落在 <dataDir>/workdirs/<agentId>）。缺省 <cwd>/data，与 store 同源。 */
  dataDir?: string
}

export const name = 'space-workdir-local'
export const inject = ['agents']

export function apply(ctx: Context, config: Config = {}) {
  // 与 space-store-sqlite 同源约定：数据目录在 <cwd>/data（库文件 database.db 就在这里）。
  const dataDir = config.dataDir ?? `${process.cwd()}/data`
  new LocalWorkdirService(ctx, dataDir)
}
