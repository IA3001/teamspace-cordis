-- 0007_identity 回滚：删身份两表 + 重建无外键/旧 CHECK 的 session_members。
CREATE TABLE IF NOT EXISTS session_members_old (
    session_id    TEXT NOT NULL,
    principal_id  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT '成员'
                  CHECK (role IN ('协调者','会议记录官','挑战者','需求分析师','DRI','成员')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
    joined_at     TEXT NOT NULL,
    left_at       TEXT,
    duty          TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, principal_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO session_members_old(session_id, principal_id, role, status, joined_at, left_at, duty)
  SELECT session_id, principal_id, role, status, joined_at, left_at, duty FROM session_members;
DROP TABLE session_members;
ALTER TABLE session_members_old RENAME TO session_members;
CREATE INDEX IF NOT EXISTS idx_session_members_status
  ON session_members(session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dri_per_session
  ON session_members(session_id)
  WHERE status='active' AND role='DRI';
DROP TABLE IF EXISTS login_tokens;
DROP TABLE IF EXISTS users;
