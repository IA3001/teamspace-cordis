-- 回滚事件域：先删触发器与 FTS 表，再删主表。
DROP TRIGGER IF EXISTS events_fts_ai;
DROP TABLE IF EXISTS events_fts;
DROP TABLE IF EXISTS events;
