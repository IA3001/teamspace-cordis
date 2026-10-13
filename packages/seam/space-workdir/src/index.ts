// seam/space-workdir —— 能力缝（P6 新增，2026-09-29）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO（IO 全在实现层）。
// 实现放 packages/impl/；只能依赖本包。依赖方向由 scripts/lint-deps.sh 强制（断言 ①②）。
//
// 词汇（2026-09-29 新需求，MODULE-PLAN §3.2 / 待定 8 已决：新缝）：
//   WorkdirHandle{agentId, root, createdAt}
//   路径隔离（execdir 铁则：解析结果逃出 root 即判红）
//
// **刻意与 space-workspace（工作台视图模型）分开** —— 防杂物袋（待定 8 用户拍板）。
// 承旧 internal/sandbox 的 execdir 语义：命令只能在工作区内执行，路径逃逸是硬错误。
// 每 agent 一区（agentId 对应 space-agent 的 AgentDescriptor.id）；
// 与沙箱 policy 的边界：本缝管「地盘在哪、边界在哪」，policy 管「进去之后能干什么」。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    workdir: WorkdirService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个 agent 的文件工作区句柄。 */
export interface WorkdirHandle {
  /** 对应 space-agent 的 AgentDescriptor.id（一 agent 一区）。 */
  agentId: string
  /** 工作区根目录（绝对路径，由实现层生成与管理）。 */
  root: string
  createdAt: number
}

export interface WorkdirEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size: number
  modifiedAt: string
}

export interface WorkdirListing {
  exists: boolean
  path: string
  entries: WorkdirEntry[]
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type WorkdirErrorCode =
  | 'not_found'
  /** 创建时目标 root 已被别的 agent 占用（路径冲突）。 */
  | 'already_assigned'
  /** Host quota registration is required but missing or failed. */
  | 'quota_unavailable'
  /** resolve 结果逃出 root —— execdir 铁则，硬错误。 */
  | 'path_escape'
  /** 释放清理失败（实现层必须带原因）。 */
  | 'cleanup_failed'

export class WorkdirError extends Error {
  constructor(
    public readonly code: WorkdirErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkdirError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · claim：幂等领取——该 agent 已有区则原样返回；没有则创建（mkdir 含父级）并在
//     配置宿主机配额时先登记；生产环境要求配额但登记不可用 → quota_unavailable。
//     root 被别的 agent 占用 → already_assigned；未知 agent（未入驻）→ not_found
//   · release：清理（删目录）并注销；清理失败 → cleanup_failed；未领取 → not_found
//   · resolve：拼接并归一化后校验仍在 root 内，逃逸 → path_escape（execdir 铁则）
//   · get / list：get 未知 → not_found；list 按 agentId 稳定排序
export abstract class WorkdirService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workdir')
  }

  /** 幂等领取：已有则原样返回，没有则创建。 */
  abstract claim(agentId: string): Promise<WorkdirHandle>

  /** 清理并注销该 agent 的工作区。 */
  abstract release(agentId: string): Promise<void>

  /** 解析相对路径并校验不出 root；返回绝对路径。 */
  abstract resolve(agentId: string, relative: string): string

  abstract get(agentId: string): WorkdirHandle

  abstract list(): WorkdirHandle[]

  /** Read-only, bounded explorer API. Paths are workspace-relative; symlinks are excluded. */
  abstract browse(agentId: string, relativePath?: string): Promise<WorkdirListing>

  /** Read-only explorer for the team-wide shared workspace, separate from each Agent's private root. */
  abstract browseShared(relativePath?: string): Promise<WorkdirListing>

  /** Read a small UTF-8 text file from an Agent workspace; binary/oversized files are rejected. */
  abstract readText(agentId: string, relativePath: string): Promise<string>

  /** Read a small UTF-8 text file from the shared workspace using the same redaction and path rules. */
  abstract readSharedText(relativePath: string): Promise<string>
}
