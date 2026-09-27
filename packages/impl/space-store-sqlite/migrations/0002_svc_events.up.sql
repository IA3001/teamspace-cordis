-- 0002_svc_events —— 事件域：只追加的事件日志 + 全文索引。
--
-- DDL 承旧系统新链 0004_svc_events 的最终形态（旧 0002 建 events → 旧 0015 重建
-- 使 author_id 可空，让"系统事件"真正能落库）。
--
-- 与旧链的**刻意差异**（记账）：
--   1. events.phase_id 不外键指向 phases（理由同 0001_svc_session）。
--   2. events.author_id **暂不**外键指向 principals（身份域后置，待定 6）。
--
-- events **只追加**：仓储层不提供 Update/Delete，废止走打标记（voided）。
--
-- events_fts：trigram 分词的外部内容表（content='events'，正文不重复存储）。
-- 选 trigram 的理由：中文检索需要（旧链 2026-09-16 实测 ngram 命中 0）；
-- ⚠ trigram 要求查询词 ≥ 3 字符 → 2 字词（"敏捷""看板"）由仓储层走 LIKE 兜底。
-- 出处：https://www.sqlite.org/fts5.html（核实日期：2026-09-16；本轮 2026-09-27 复用）。

CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,         -- 幂等键
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    phase_id      TEXT,                     -- 阶段 id 由 kickoff 插件域定义
    ts            TEXT NOT NULL,
    -- NULL = 系统事件（不是任何参与者说的）
    author_id     TEXT,
    author_kind   TEXT NOT NULL CHECK (author_kind IN ('human','agent','system')),
    kind          TEXT NOT NULL CHECK (kind IN ('message','decision','approval','system')),
    text          TEXT NOT NULL DEFAULT '',
    mentions      TEXT NOT NULL DEFAULT '[]',  -- JSON [principal_id]，显式实体
    tool_calls    TEXT NOT NULL DEFAULT '[]',  -- JSON [{name,args,result?}]
    reply_mode    TEXT NOT NULL DEFAULT '',    -- 长回复 / 快速回复
    voided        INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0,1)),
    voided_by     TEXT,                        -- 谁废止的（留痕）
    voided_at     TEXT,
    voided_reason TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_phase_ts   ON events(phase_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_author     ON events(author_id);

-- 全文索引（外部内容表模式）+ 同步触发器。
-- events 只追加，所以只需要 INSERT 触发器 —— 建了 UPDATE/DELETE 触发器
-- 反而会让人以为可以改事件。
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    text,
    content='events',
    content_rowid='rowid',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;
