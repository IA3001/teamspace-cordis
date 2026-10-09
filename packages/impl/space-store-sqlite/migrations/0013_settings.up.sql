-- 0013_settings —— 运行时键值设置（模型接入等，2026-10-05）。
--
-- 为什么要有这张表：cordis 面板的原生 schemastery 配置表单对本地 ts 插件
-- 渲染不出来（插件页「此插件尚未安装」），模型/向量接入需要一个面板可改、
-- 持久化、进程内即改即用的通道。键值对即可，勿过度建模。
--
-- 键名约定见 seam/space-settings：llm.* / embed.*（谁消费谁定义）。
-- 值一律 JSON 文本；API Key 属敏感值，实现层保证**不落日志**（本表不打印）。

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,          -- 点分层级键："llm.apiKey"
    value      TEXT NOT NULL,             -- JSON 序列化的值
    updated_at TEXT NOT NULL
);
