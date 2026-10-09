-- 0007_identity —— 身份域落地（IM 化改造 2026-09-30，用户拍板）。
--
-- 内容：
--   1. users 表：人类（username+password 登录）与 agent（kind='agent'，无密码，
--      不允许登录）统一进一张身份表 —— principal_id 从"自由字符串"变成
--      有出处的外键域（0001 记账里承诺的"身份域落地时把外键加回来"在 SQLite
--      里需要建新表-搬数据-改名的重建路径，本迁移对 session_members 一并做）。
--   2. login_tokens 表：不透明 token（服务端签发、HttpOnly cookie 携带）。
--   3. session_members 重建：role 词汇表加 IM 语义的 '群主'（创建者）与
--      '管理员'；旧六角色原样保留（兼容 seed 与既有数据）。单 active DRI
--      部分唯一索引原样重建（DRI 语义保留，但 IM 下人类默认 '成员'）。
--
-- 记账（对 0001 差异说明第 2 条的兑现）：principal_id 外键在此加回。

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,                    -- "u_*"（人）/ "a_*"（agent）
    username      TEXT NOT NULL UNIQUE,                -- 登录名（agent 用 principal_id 充当）
    password_hash TEXT NOT NULL,                       -- scrypt；agent 行固定 '!'（不可登录占位）
    display_name  TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human','agent')),
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tokens (
    token      TEXT PRIMARY KEY,                       -- 随机 32B hex
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);

-- 重建 session_members：扩 role CHECK（+'群主','管理员'）+ principal_id 外键。
-- 身份先入册（幂等），再重建 session_members —— 外键要求被引用行先存在。
-- username = principal_id；password_hash = '!'（scrypt 永不接受的占位，不可登录）。
-- id 与 agent 插件实际入会用的 id 逐字一致：会议域 a_*、coding 域 agent.*
-- （agent-coder-stub 等的 AGENT_ID）；u_dri 是 seed 演示数据的既有人类身份。
INSERT OR IGNORE INTO users(id, username, password_hash, display_name, kind, created_at) VALUES
  ('u_dri',         'u_dri',         '!', '决策与审批', 'human', '2026-09-30T00:00:00.000Z'),
  ('a_coordinator', 'a_coordinator', '!', '协调者', 'agent', '2026-09-30T00:00:00.000Z'),
  ('a_analyst',     'a_analyst',     '!', '需求分析师', 'agent', '2026-09-30T00:00:00.000Z'),
  ('a_challenger',  'a_challenger',  '!', '挑战者', 'agent', '2026-09-30T00:00:00.000Z'),
  ('a_recorder',    'a_recorder',    '!', '会议记录官', 'agent', '2026-09-30T00:00:00.000Z'),
  ('agent.coder',   'agent.coder',   '!', '编码者', 'agent', '2026-09-30T00:00:00.000Z'),
  ('agent.tester',  'agent.tester',  '!', '测试者', 'agent', '2026-09-30T00:00:00.000Z'),
  ('agent.reviewer','agent.reviewer','!', '代码审查者', 'agent', '2026-09-30T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS session_members_new (
    session_id    TEXT NOT NULL,
    principal_id  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT '成员'
                  CHECK (role IN ('协调者','会议记录官','挑战者','需求分析师','DRI','成员','群主','管理员')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
    joined_at     TEXT NOT NULL,
    left_at       TEXT,
    duty          TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, principal_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (principal_id) REFERENCES users(id)
);
INSERT INTO session_members_new(session_id, principal_id, role, status, joined_at, left_at, duty)
  SELECT session_id, principal_id, role, status, joined_at, left_at, duty FROM session_members;
DROP TABLE session_members;
ALTER TABLE session_members_new RENAME TO session_members;
CREATE INDEX IF NOT EXISTS idx_session_members_status
  ON session_members(session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dri_per_session
  ON session_members(session_id)
  WHERE status='active' AND role='DRI';
