-- 0004_staging_entries 的回滚：删索引、删表。
-- 暂存区是「未提交的草稿」，回滚迁移连数据一起消失是可以接受的
-- （与业务事件 events 的「留表不回滚」不同 —— events 不在本链回滚，
--   staging 未提交内容没有历史价值）。
DROP INDEX IF EXISTS idx_staging_author;
DROP INDEX IF EXISTS idx_staging_session_seq;
DROP TABLE IF EXISTS staging_entries;
