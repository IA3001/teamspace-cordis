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
      reply_to: string | null
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
    prompt_templates: {
      ref: string
      title: string
      body: string
      updated_at: string
    }
    users: {
      id: string
      username: string
      password_hash: string
      display_name: string
      kind: string
      created_at: string
      team_role: string
    }
    login_tokens: {
      token: string
      user_id: string
      created_at: string
      expires_at: string
    }
    memories: {
      id: string
      scope: string
      kind: string
      text: string
      weight: number
      author_id: string | null
      created_at: string
      source_event_id: string | null
    }
    msg_reactions: {
      event_id: string
      user_id: string
      emoji: string
      created_at: string
    }
    kb_documents: {
      id: string
      title: string
      source: string
      size: number
      created_at: string
    }
    kb_chunks: {
      id: string
      doc_id: string
      idx: number
      text: string
      embedding: string
      created_at: string
    }
    agent_definitions: {
      id: string
      title: string
      description: string
      prompt_ref: string
      model_ref: string
      tool_ids: string
      context_sources: string
      memory_policy: string
      speech_policy: string
      status: string
      created_at: string
      updated_at: string
    }
    admin_accounts: {
      id: string
      username: string
      password_hash: string
      created_at: string
      updated_at: string
    }
    admin_sessions: {
      token: string
      admin_id: string
      created_at: string
      expires_at: string
    }
    sandbox_approval_requests: {
      id: string; agent_id: string; session_id: string | null; source_path: string; source_size: number
      source_mtime_ms: number; source_ctime_ms: number; source_inode: number; reason: string
      status: string; created_at: string; decided_at: string | null; decided_by: string | null
      decision_note: string; delivery_path: string | null
    }
    session_work_owners: { process_id: string; session_id: string; owner: string; expires_at: number }
    session_work_queue: { queue_id: number; process_id: string; session_id: string; owner: string; enqueued_at: number; expires_at: number }
    file_attachments: { stored_name: string; session_id: string; uploader_id: string; original_name: string; size_bytes: number; created_at: string }
  }
}
import { SqliteEventLog } from './eventlog.ts'
import { SqlitePromptStore } from './prompt.ts'
import { SqliteStagingStore } from './staging.ts'
import { currentVersion, expectedVersion } from './loader.ts'
import { SqliteSessionStore } from './session.ts'
import { SqliteUserStore } from './users.ts'
import { SqliteMemoryStore } from './memory.ts'
import { SqliteKnowledgeStore } from './kb.ts'
import { SqliteSettingsStore } from './settings.ts'
import { SqliteAgentCatalog } from './agent-catalog.ts'
import { SqliteAdminAuthStore } from './admin-auth.ts'
import { SqliteSandboxApproval } from './sandbox-approval.ts'
import { SqliteSessionWork } from './session-work.ts'

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
    reply_to: { type: 'string', nullable: true },
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

  // 提示词模板（P8）：与 0006_prompt_templates 逐列对齐（ref 主键）。
  ctx.database.extend('prompt_templates', {
    ref: { type: 'string', nullable: false },
    title: { type: 'string', nullable: false },
    body: { type: 'string', nullable: false },
    updated_at: { type: 'string', nullable: false },
  }, { primary: 'ref' })

  // Team 身份域（管理员另走 admin_accounts/admin_sessions）：与 0007、0016 对齐。
  ctx.database.extend('users', {
    id: { type: 'string', nullable: false },
    username: { type: 'string', nullable: false },
    password_hash: { type: 'string', nullable: false },
    display_name: { type: 'string', nullable: false },
    kind: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    team_role: { type: 'string', nullable: false },
  }, { primary: 'id' })
  ctx.database.extend('login_tokens', {
    token: { type: 'string', nullable: false },
    user_id: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    expires_at: { type: 'string', nullable: false },
  }, { primary: 'token' })

  // 记忆层（分层 L1，2026-09-30）：与 0008_memory 逐列对齐。
  ctx.database.extend('memories', {
    id: { type: 'string', nullable: false },
    scope: { type: 'string', nullable: false },
    kind: { type: 'string', nullable: false },
    text: { type: 'string', nullable: false },
    weight: { type: 'double', nullable: false },
    author_id: { type: 'string', nullable: true },
    created_at: { type: 'string', nullable: false },
    source_event_id: { type: 'string', nullable: true },
  }, { primary: 'id' })

  // 表情回应（IM 化 2026-10-01）：与 0009_reactions 逐列对齐（三元组复合主键）。
  ctx.database.extend('msg_reactions', {
    event_id: { type: 'string', nullable: false },
    user_id: { type: 'string', nullable: false },
    emoji: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
  }, { primary: ['event_id', 'user_id', 'emoji'] })

  // 知识库域（2026-10-01）：与 0010_knowledge 逐列对齐（kb_chunks_fts 是
  // 外部内容表，注册无意义且驱动表达不了 FTS5 —— 只注册两张真表）。
  ctx.database.extend('kb_documents', {
    id: { type: 'string', nullable: false },
    title: { type: 'string', nullable: false },
    source: { type: 'string', nullable: false },
    size: { type: 'integer', nullable: false },
    created_at: { type: 'string', nullable: false },
  }, { primary: 'id' })
  ctx.database.extend('kb_chunks', {
    id: { type: 'string', nullable: false },
    doc_id: { type: 'string', nullable: false },
    idx: { type: 'integer', nullable: false },
    text: { type: 'string', nullable: false },
    embedding: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
  }, { primary: 'id' })

  // Team-shared Agent definitions (0014); deliberately no creator/owner field.
  ctx.database.extend('agent_definitions', {
    id: { type: 'string', nullable: false },
    title: { type: 'string', nullable: false },
    description: { type: 'string', nullable: false },
    prompt_ref: { type: 'string', nullable: false },
    model_ref: { type: 'string', nullable: false },
    tool_ids: { type: 'string', nullable: false },
    context_sources: { type: 'string', nullable: false },
    memory_policy: { type: 'string', nullable: false },
    speech_policy: { type: 'string', nullable: false },
    status: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    updated_at: { type: 'string', nullable: false },
  }, { primary: 'id' })

  // 后台身份与 Team users 完全分离；凭据与会话单独持久化。
  ctx.database.extend('admin_accounts', {
    id: { type: 'string', nullable: false },
    username: { type: 'string', nullable: false },
    password_hash: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    updated_at: { type: 'string', nullable: false },
  }, { primary: 'id' })
  ctx.database.extend('admin_sessions', {
    token: { type: 'string', nullable: false },
    admin_id: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false },
    expires_at: { type: 'string', nullable: false },
  }, { primary: 'token' })
  ctx.database.extend('sandbox_approval_requests', {
    id: { type: 'string', nullable: false }, agent_id: { type: 'string', nullable: false },
    session_id: { type: 'string', nullable: true }, source_path: { type: 'string', nullable: false },
    source_size: { type: 'integer', nullable: false }, source_mtime_ms: { type: 'float', nullable: false },
    source_ctime_ms: { type: 'float', nullable: false }, source_inode: { type: 'integer', nullable: false },
    reason: { type: 'string', nullable: false }, status: { type: 'string', nullable: false },
    created_at: { type: 'string', nullable: false }, decided_at: { type: 'string', nullable: true },
    decided_by: { type: 'string', nullable: true }, decision_note: { type: 'string', nullable: false },
    delivery_path: { type: 'string', nullable: true },
  }, { primary: 'id' })
  ctx.database.extend('session_work_owners', {
    process_id: { type: 'string', nullable: false }, session_id: { type: 'string', nullable: false },
    owner: { type: 'string', nullable: false }, expires_at: { type: 'integer', nullable: false },
  }, { primary: ['process_id', 'session_id', 'owner'] })
  ctx.database.extend('session_work_queue', {
    queue_id: { type: 'integer', nullable: false }, process_id: { type: 'string', nullable: false },
    session_id: { type: 'string', nullable: false }, owner: { type: 'string', nullable: false },
    enqueued_at: { type: 'integer', nullable: false }, expires_at: { type: 'integer', nullable: false },
  }, { primary: 'queue_id' })
  ctx.database.extend('file_attachments', {
    stored_name: { type: 'string', nullable: false }, session_id: { type: 'string', nullable: false },
    uploader_id: { type: 'string', nullable: false }, original_name: { type: 'string', nullable: false },
    size_bytes: { type: 'integer', nullable: false }, created_at: { type: 'string', nullable: false },
  }, { primary: 'stored_name', indexes: [['session_id', 'created_at']] })

  // ── 4. 两个缝的真正实现 ───────────────────────────────────────────────────
  new SqliteSessionStore(ctx, db) // 提供 ctx.session
  new SqliteUserStore(ctx, db) // 提供 ctx.users（身份域，IM 化）
  new SqliteMemoryStore(ctx, db) // 提供 ctx.memory（记忆层，L1）
  const eventLog = new SqliteEventLog(ctx, db) // 提供 ctx.eventLog
  // staging 的 commit 要落人类发言事件（跨缝组合在同一 impl 内完成，
  // 契约见 seam/space-staging 的 commit），所以把 eventLog 递给它。
  new SqliteStagingStore(ctx, db, eventLog) // 提供 ctx.staging
  // 提示词模板（P8）：内容资产（get/upsert/list），DDL 唯一出处 migrations/0006。
  new SqlitePromptStore(ctx, db) // 提供 ctx.prompts
  new SqliteKnowledgeStore(ctx, db) // 提供 ctx.kb（知识库域，2026-10-01）
  new SqliteSettingsStore(ctx, db) // 提供 ctx.settings（运行时设置 KV，2026-10-05）
  new SqliteAgentCatalog(ctx, db) // 提供 ctx.agentCatalog（团队共享定义，0014）
  new SqliteAdminAuthStore(ctx, db) // 提供 ctx.adminAuth（后台独立身份，0015）
  new SqliteSandboxApproval(ctx, db) // 提供后台审批队列与决策记录（0023）
  const sessionWork = new SqliteSessionWork(ctx, db) // 跨进程会话槽位与租约队列（0024）

  console.log(
    `[${name}] 就绪：${path}（schema v${current}，Team 用户 / 后台管理员身份分离）`,
  )

  // 清理：cordis v4 惯用法 —— apply 返回函数即 disposer（卸载/停止时关库连接）。
  return () => { sessionWork.dispose(); db.close() }
}
