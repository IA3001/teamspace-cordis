-- 0008_memory —— 记忆层（分层架构 L1，2026-09-30 用户拍板）。
--
-- memories 表：挂在 scope（'session:<id>' / 'agent:<id>' / 'global'）上的
-- append-only 记忆账本 + 显式遗忘。服务于上下文注入层（space-context）与
-- 检索层（space-retrieval），不直接面向 UI / Agent。
-- 语义契约见 seam/space-memory。

CREATE TABLE IF NOT EXISTS memories (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 0.5,
    author_id  TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope
  ON memories(scope, created_at DESC);
