-- 0004_staging_entries —— 暂存区插件域表（space-staging seam 的存储）。
--
-- 迁移口径承旧 store/doc.go：插件域表随插件落地，迁移文件用表名前缀。
-- 旧链为它预留的编号是 0006；本链现到 0003，故落 0004。
-- 旧 Go 系统从未建过这张表（前端 StagingPanel.vue 只是意图契约）——
-- 这是它第一次真实落地（2026-09-27，P2）。
--
-- 硬约束（project_memory / MODULE-PLAN 3.2）：
--   · 字段恰为 Entry{ID, SessionID, AuthorID, Seq, Text, CreatedAt}
--   · (session_id, seq) 唯一索引：seq 会话内自增（应用层 max+1）、删除后不重排
--   · 会话删除 → 条目级联删除（ON DELETE CASCADE）
--   · 「只有作者能改/撤自己的条目」是行为校验（impl/staging.ts），不靠约束表达

CREATE TABLE IF NOT EXISTS staging_entries (
    id         TEXT PRIMARY KEY,              -- 幂等键（uuid）
    session_id TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,              -- 会话内自增，删除后不重排
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,                 -- ISO 8601（UTC）
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_session_seq ON staging_entries(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_staging_author ON staging_entries(author_id);
