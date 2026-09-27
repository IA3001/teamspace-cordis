-- 0001_svc_session —— 会话域：会议（业务会话）与在册成员。
--
-- DDL 承旧系统新链 0003_svc_session 的最终形态（旧 0002 建 sessions/session_members
-- → 旧 0004 成员加会话内角色 + 单 DRI 约束 → 旧 0036 加「协调者」角色与 duty 列）。
--
-- 与旧链的**刻意差异**（记账，不许只改内容不写理由）：
--   1. sessions.current_phase 不外键指向 phases 表 —— phases 归 kickoff 插件域，
--      核心链不依赖插件域表（承旧链同一决定）。
--   2. session_members.principal_id **暂不**外键指向 principals —— 身份域按
--      MODULE-PLAN 待定 6 后置（P1 只搬三张表）。等身份域落地时用新迁移把
--      外键加回来（SQLite 加外键需要走建新表-搬数据-改名的重建路径）。
--
-- 「一个会话最多一个在册 DRI」由数据库保证（部分唯一索引）：
-- 审批权归当轮 DRI，审批是不可逆动作的闸门，不能不确定。

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,         -- "s_<id>"
    title         TEXT NOT NULL,
    current_phase TEXT,                     -- 阶段 id 由 kickoff 插件域定义
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_members (
    session_id    TEXT NOT NULL,
    principal_id  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT '成员',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
    joined_at     TEXT NOT NULL,
    left_at       TEXT,                     -- NULL = 从未离开
    duty          TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, principal_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    CHECK (role IN ('协调者','会议记录官','挑战者','需求分析师','DRI','成员'))
);
CREATE INDEX IF NOT EXISTS idx_session_members_status
    ON session_members(session_id, status);

-- 一个会话最多一个**在册** DRI（部分唯一索引：只对 active + DRI 的行生效）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dri_per_session
    ON session_members(session_id)
    WHERE status='active' AND role='DRI';
