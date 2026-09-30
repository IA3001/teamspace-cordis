-- 0006_prompt_templates —— 提示词模板表（P8 机制层，2026-09-30）。
--
-- ref 是稳定标识（AgentDescriptor.promptRef 指向它，如 'prompt.minutes'）；
-- 内容本体住这里，引用与内容分离 —— 换文案零改名单（待定 10 接入形态）。
-- 当前 4 条占位内容由 seed/0002_svc_prompt.sql 预置（明示「待原文」）。
--
-- 幂等：IF NOT EXISTS / DROP TABLE IF EXISTS（up→down→up 幂等，store.ts 口径）。

CREATE TABLE IF NOT EXISTS prompt_templates (
  ref        TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
