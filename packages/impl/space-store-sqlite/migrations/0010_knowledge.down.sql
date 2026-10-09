-- 回滚知识库域：先删触发器与 FTS 表，再删主表（照 0002_svc_events.down 顺序）。
DROP TRIGGER IF EXISTS kb_chunks_fts_ai;
DROP TRIGGER IF EXISTS kb_chunks_fts_ad;
DROP TABLE IF EXISTS kb_chunks_fts;
DROP TABLE IF EXISTS kb_chunks;
DROP TABLE IF EXISTS kb_documents;
