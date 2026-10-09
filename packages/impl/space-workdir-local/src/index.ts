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
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import { WorkdirError, WorkdirService } from 'space-workdir'
import type { WorkdirHandle } from 'space-workdir'

const execFileAsync = promisify(execFile)
export interface WorkdirQuotaOptions {
  ensure?: (agentId: string) => Promise<void>
  required?: boolean
}

export class LocalWorkdirService extends WorkdirService {
  /** agentId → handle（进程内台账；目录在磁盘，重启后按需重建台账由 claim 补登）。 */
  private readonly handles = new Map<string, WorkdirHandle>()

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
