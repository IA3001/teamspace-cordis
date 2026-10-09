-- 回滚 0011_admin：DROP COLUMN 需 SQLite 3.35+（node:sqlite 内置版满足）。
ALTER TABLE users DROP COLUMN is_admin;
