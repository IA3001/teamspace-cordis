// impl/space-store-sqlite —— ctx.session / ctx.eventLog 的 sqlite 后端。
//
// 职责（P1，方案 A —— 用户拍板 2026-09-27）：
//   1. 打开 data/database.db（与 debug-database-sqlite **同一个文件**）
//   2. 校验 schema_version：与迁移链期望版本不一致 → 拒绝启动
//      （承旧 store/doc.go 口径；这是防止驱动把 schema 绕过迁移链偷改的第一道闸）
//   3. ctx.database.extend(...) 注册与迁移 DDL **逐列对齐**的 model ——
//      让 5172 调试控制台的数据库页能看到三张业务表（铁律 2：数据要看得见）。
//      ⚠️ DDL 权威在 migrations/ 目录（独立命令 npm run migrate）；
//      model 注册只为展示，类型必须与 PRAGMA table_info 完全一致 ——
//      否则 sqlite 驱动会判定"需要迁移"并做临时表重建，把 CHECK 约束 /
//      FTS5 触发器 / 部分 unique 索引全部抹掉（驱动源码 plugin-database-sqlite
//      prepare() 的行为，2026-09-27 读源码确认）。
//   4. 提供两个缝的真正实现（SQL 读写走 node:sqlite 直连，保留 CHECK /
//      FTS5 / 部分索引的完整能力 —— minato 表达不了这些）。
//
// 断言 ⑧（DDL 只在迁移里）：本文件没有一行建表语句 —— 扫描器会盯住这一点。
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
// 引入类型：plugin-database 对 cordis 的 Context augmentation（ctx.database）
import type {} from '@cordisjs/plugin-database'

// ── 表类型声明（augment plugin-database 的 Tables）─────────────────────────
// 与迁移 DDL 逐列对应（migrations/0001~0003）。列名保持 snake_case = 库里原名；
// 类型只能声明为宽类型（string/number/boolean），SQLite 列亲和性的约束
// 由库里的 CHECK / NOT NULL 兜底，这里不重复表达。
declare module '@cordisjs/plugin-database' {
  interface Tables {
    sessions: {
      id: string
      title: string
      current_phase: string | null
      status: string
      created_at: string
      updated_at: string
    }
    session_members: {
      session_id: string
      principal_id: string
      role: string
      status: string
      joined_at: string
      left_at: string | null
      duty: string
    }
    events: {
      id: string
      session_id: string
      seq: number
      phase_id: string | null
      ts: string
      author_id: string | null
      author_kind: string
      kind: string
      text: string
      mentions: string
      tool_calls: string
      reply_mode: string
      voided: boolean
      voided_by: string | null
      voided_at: string | null
      voided_reason: string | null
    }
    action_log: {
      id: number
      action: string
      detail: string
      ok: boolean
      created_at: string
    }
    staging_entries: {
      id: string
      session_id: string
      author_id: string
      seq: number
      text: string
      mentions: string
      created_at: string
    }
  }
}
import { SqliteEventLog } from './eventlog.ts'
import { SqliteStagingStore } from './staging.ts'
import { currentVersion, expectedVersion } from './loader.ts'
import { SqliteSessionStore } from './session.ts'

export const name = 'space-store-sqlite'
// database 服务由 debug-database-sqlite（驱动插件）提供；未就绪时本插件不加载。
export const inject = ['database']

export interface Config {
  /** 缺省与 debug-database-sqlite 同文件（cordis.yml 里显式写同一处路径）。 */
  path?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const path = config.path ?? `${process.cwd()}/data/database.db`
  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))

  // ── 1. 打开数据库（与驱动插件并发访问同一文件：WAL + busy_timeout 兜住）────
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(`PRAGMA busy_timeout = 5000`)
  db.exec(`PRAGMA synchronous = NORMAL`)

  // ── 2. schema_version 校验（不一致拒绝启动，承旧 store/doc.go）────────────
  const current = currentVersion(db)
  const expected = expectedVersion(migrationsDir)
  if (current !== expected) {
    const hint =
      current < expected
        ? `先跑 npm run migrate（当前 v${current} → 期望 v${expected}）`
        : `库的 schema 版本 v${current} 比迁移链（v${expected}）新 —— 迁移文件被删改过？`
    db.close()
    throw new Error(
      `[${name}] schema_version 不一致，拒绝启动：${hint}\n` +
        `  （这是防呆：不允许任何代码绕过迁移链改动表结构 —— 断言 ⑧）`,
    )
  }

  // ── 3. model 注册（只为 5172 数据库页展示；类型与迁移 DDL 逐列对齐）────────
  // 字段类型映射（@cordisjs/plugin-database-sqlite getTypeDef）：
  //   string → TEXT ｜ integer / boolean → INTEGER —— 与 PRAGMA table_info 一致。
  // nullable 标注与迁移 DDL 的 NOT NULL 对应（只影响 CREATE 路径，此处为诚实标注）。
  ctx.database.extend('sessions', {
    id: { type: 'string', nullable: false },
    title: { type: 'string', nullable: false },
    current_phase: { type: 'string', nullable: true },
    status: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    updated_at: { type: 'string', nullable: false },
  }, { primary: 'id' })

  ctx.database.extend('session_members', {
    session_id: { type: 'string', nullable: false },
    principal_id: { type: 'string', nullable: false },
    role: { type: 'string', nullable: false },
    status: { type: 'string', nullable: false },
    joined_at: { type: 'string', nullable: false },
    left_at: { type: 'string', nullable: true },
    duty: { type: 'string', nullable: false },
  }, { primary: ['session_id', 'principal_id'] })

  ctx.database.extend('events', {
    id: { type: 'string', nullable: false },
    session_id: { type: 'string', nullable: false },
    seq: { type: 'integer', nullable: false },
    phase_id: { type: 'string', nullable: true },
    ts: { type: 'string', nullable: false },
    author_id: { type: 'string', nullable: true },
    author_kind: { type: 'string', nullable: false },
    kind: { type: 'string', nullable: false },
    text: { type: 'string', nullable: false },
    mentions: { type: 'string', nullable: false },
    tool_calls: { type: 'string', nullable: false },
    reply_mode: { type: 'string', nullable: false },
    voided: { type: 'boolean', nullable: false },
    voided_by: { type: 'string', nullable: true },
    voided_at: { type: 'string', nullable: true },
    voided_reason: { type: 'string', nullable: true },
  }, { primary: 'id' })

  // 动作留痕（断言 ⑨）：也是真表，一样注册展示。
  ctx.database.extend('action_log', {
    id: { type: 'integer', nullable: false },
    action: { type: 'string', nullable: false },
    detail: { type: 'string', nullable: false },
    ok: { type: 'boolean', nullable: false },
    created_at: { type: 'string', nullable: false },
  }, { primary: 'id', autoInc: true })

  // 暂存区（P2）：与 0004_staging_entries 逐列对齐。
  ctx.database.extend('staging_entries', {
    id: { type: 'string', nullable: false },
    session_id: { type: 'string', nullable: false },
    author_id: { type: 'string', nullable: false },
    seq: { type: 'integer', nullable: false },
    text: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
  }, { primary: 'id' })

  // ── 4. 两个缝的真正实现 ───────────────────────────────────────────────────
  new SqliteSessionStore(ctx, db) // 提供 ctx.session
  const eventLog = new SqliteEventLog(ctx, db) // 提供 ctx.eventLog
  // staging 的 commit 要落人类发言事件（跨缝组合在同一 impl 内完成，
  // 契约见 seam/space-staging 的 commit），所以把 eventLog 递给它。
  new SqliteStagingStore(ctx, db, eventLog) // 提供 ctx.staging

  console.log(
    `[${name}] 就绪：${path}（schema v${current}，业务表 sessions / session_members / events / staging_entries + 留痕表 action_log）`,
  )

  // 清理：cordis v4 惯用法 —— apply 返回函数即 disposer（卸载/停止时关库连接）。
  return () => db.close()
}
