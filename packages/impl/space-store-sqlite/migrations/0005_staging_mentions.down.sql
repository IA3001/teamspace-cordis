-- 0005_staging_mentions 回滚：删列（SQLite 3.35+ 支持 DROP COLUMN；
-- node:sqlite 绑定的 SQLite 版本满足）。暂存草稿无历史价值（同 0004 口径），
-- 丢提及不丢事件。

ALTER TABLE staging_entries DROP COLUMN mentions;
