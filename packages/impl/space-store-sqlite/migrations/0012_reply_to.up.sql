-- 0012_reply_to —— 引用/回复关系（2026-10-02，引用系统化）。
--
-- events.reply_to：指向本会话内被引用的事件 id。可空（绝大多数消息无引用）；
-- 不加外键约束（被引用事件永久存在于 append-only 账本，回滚场景不存在；
-- 引用方渲染时自行解析，原事件 voided 则显示「原消息已撤回」）。

ALTER TABLE events ADD COLUMN reply_to TEXT;
