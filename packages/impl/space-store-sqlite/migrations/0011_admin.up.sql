-- 0011_admin —— 账号管理（2026-10-01）：users 表加 is_admin 标记。
--
-- 无邀请制下的初始化规则：第一个注册的用户自动成为管理员（由 impl/users.ts
-- 的 register 落库后回填，本迁移只负责给列）。0 = 普通用户，1 = 管理员。
-- agent 身份永不置位（impl 层把守）。
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
