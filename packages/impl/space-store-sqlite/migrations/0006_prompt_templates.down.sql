-- 0006_prompt_templates.down —— 回滚删表（提示词是内容资产可重建，
-- 与 staging「草稿无历史价值」同口径；模板重装由 seed 重播）。
DROP TABLE IF EXISTS prompt_templates;
