# 当前会话待办只读工具兼容说明

此变更新增 `tool.session.todos`，从 `session:<sessionId>` / `kind=todo` 读取待办并返回持久化 ID、状态、文本和创建时间。它只接受调用者当前会话范围，不改变现有记忆行或待办 API。

Agent Catalog 的 `coding` 起始模板从 v1 升至 v2，新增该只读工具。数据库迁移 0037 只为既有 `agent.coder` 追加缺失的工具 ID，不覆盖其余工具和配置；其他 Agent 可通过现有工具选择器显式启用。

## 升级与回退

从 schema v36 升级时应用迁移 0037。若 `agent.coder` 存在且尚未配置该工具，迁移会追加 `tool.session.todos`；重复运行迁移不会重复添加。已有同名工具 ID 会保持不变。

回退程序保留 Agent Catalog 的可编辑数据，因此 0037 的 down migration 不删除工具 ID。回退代码时该 ID 会暂时指向未注册工具；重新部署包含该工具的版本即可恢复可用。无需回退任何待办记忆数据。

兼容性断言由 `scripts/verify-agent-bootstrap.ts`（迁移后内置 Agent 权限）与 `scripts/verify-session-todo-tool.ts`（真实工具目录、会话范围和只读拒绝）覆盖。
