// seam/space-memory —— 记忆层能力缝（2026-09-30 分层架构补真）。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现由 impl/space-memory-sqlite 提供（ctx.memory）：记忆的写入 / 按近因
// 召回 / 全文检索 / 遗忘。记忆层服务于上下文注入层（space-context）与
// 检索层（space-retrieval），不直接面向 UI 或 Agent。
//
// 词汇（承旧 elements/memory/ 的私有记忆接口 + 本次分层化扩充）：
//   · 记忆挂在 scope 上（'session:<id>' / 'agent:<id>' / 'global'）——
//     会话记忆随会话，agent 记忆跨会话，global 是全系统备忘。
//   · append-only + 显式遗忘（forget）：与事件域同款账本精神，不物理篡改历史。
//   · 重要性 weight 由写入方自评（0~1），召回按 weight×新近度排序。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    memory: MemoryService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一条记忆。对应 memories 表一行。 */
export interface MemoryItem {
  id: string
  /** 'session:<id>' | 'agent:<id>' | 'global'。 */
  scope: string
  /** 开放词表：'note' | 'fact' | 'summary' | 'artifact' | 'preference'。 */
  kind: string
  text: string
  /** 重要性 0~1（写入方自评；缺省 0.5）。 */
  weight: number
  /** 写入者 principal id（审计）。 */
  authorId: string | null
  createdAt: string
}

/** 召回选项。 */
export interface RecallOptions {
  limit?: number
  /** 只召回该 kind。 */
  kind?: string
  /** 召回 floor：weight 低于此值的丢弃（缺省 0）。 */
  minWeight?: number
}

// ── 错误分类法（实现与策略不得自造错误串）────────────────────────────────
export type MemoryErrorCode = 'empty_text' | 'bad_scope' | 'not_found' | 'invalid_weight'

export class MemoryError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · scope 合法形状 = ^(session|agent):[A-Za-z0-9._-]+$ 或 'global'（违者 bad_scope）。
//   · weight ∈ [0,1]（违者 invalid_weight）；text 拒空白（empty_text）。
//   · recall：按 weight 与 createdAt 综合排序（新者优先，同权后到先得）。
//   · search：子串/FTS 检索（实现自选，语义 = 包含 query 的记忆）。
//   · forget：软删或硬删均可，但必须幂等（不存在也返回，不炸）。
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /** 写一条记忆，返回落定后的完整条目。 */
  abstract remember(scope: string, kind: string, text: string, opts?: {
    weight?: number
    authorId?: string | null
  }): Promise<MemoryItem>

  /** 按近因 + 重要性召回某 scope 的记忆（上下文注入层的主入口）。 */
  abstract recall(scope: string, opts?: RecallOptions): Promise<MemoryItem[]>

  /** 全文检索某 scope（检索层的记忆侧数据源）。 */
  abstract search(scope: string, query: string, limit?: number): Promise<MemoryItem[]>

  /** 遗忘一条记忆（幂等）。 */
  abstract forget(id: string): Promise<void>
}
