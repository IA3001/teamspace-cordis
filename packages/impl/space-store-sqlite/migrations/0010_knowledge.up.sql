-- 0010_knowledge —— 知识库域：人工灌入的文档 + 分块 + 全文索引。
--
-- kb_documents：一份灌入的原始文档（标题 + 元信息；正文按块落 kb_chunks，
--   不在文档行上重复存储，避免同文两处）。
-- kb_chunks：分块。embedding 列为 JSON 数组（'[]' = 尚未回填），Embedding
--   服务可用时由检索层回填做向量相似度；本迁移只管形状，不管算法。
--
-- kb_chunks_fts：trigram 分词的外部内容表（content='kb_chunks'，仿
--   0002_svc_events 的 events_fts 写法）。选 trigram 理由同 0002：中文检索
--   需要。⚠ trigram 要求查询词 ≥ 3 字符 → 2 字词由仓储层走 LIKE 兜底
--   （双口径惯例，出处：https://www.sqlite.org/fts5.html，2026-10-01 复用）。
-- kb_chunks.text 不改写（append-only 语义），但 embedding 回填走 UPDATE ——
--   text 列不参与 UPDATE，所以 FTS 不会失同步；仍建 DELETE 触发器兜底级联删。

CREATE TABLE IF NOT EXISTS kb_documents (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',   -- 开放词表：'manual' | 'file' | 'url' | ...
    size       INTEGER NOT NULL DEFAULT 0,       -- 原文字符数（分块前的长度）
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_chunks (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,                 -- 块在文档内的序号（从 0 起）
    text       TEXT NOT NULL,
    embedding  TEXT NOT NULL DEFAULT '[]',       -- JSON number[]；'[]' = 未回填
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id, idx);

-- 全文索引（外部内容表模式）+ 同步触发器。
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
    text,
    content='kb_chunks',
    content_rowid='rowid',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
