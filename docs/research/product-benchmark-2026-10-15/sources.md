# 资料索引与研究边界

查阅日期：2026-10-15。仅采用官方资料支持竞品事实。网页会更新，本次研究不声称固定了竞争产品的实现版本。

| 产品 | 官方资料 | 支持的观察 | 未验证事项 |
| --- | --- | --- | --- |
| Taskade | [Workspace](https://www.taskade.com/wiki/taskade/workspace)；[Multi-Agents](https://www.taskade.com/learn/agents/multi-agents) | 工作容器、Agent 团队模式、任务位置交互和连接项目知识 | 登录后完整体验、实际并发表现、代码版本交接与成功率 |
| Linear | [概念](https://linear.app/docs/conceptual-model)；[任务分配](https://linear.app/docs/assigning-issues)；[Agent](https://linear.app/docs/agents-in-linear) | Issue 归属、人类责任与 Agent 委托、任务活动记录 | 我们所需全部多 Agent 协作能力、当前账户可用功能 |
| Teams | [Facilitator 使用](https://support.microsoft.com/en-us/teams/copilot/facilitator-in-microsoft-teams-meetings)；[管理与限制](https://learn.microsoft.com/MicrosoftTeams/facilitator-teams) | 会议笔记、会后成果入口、正式/预览区分 | 本地租户授权、预览能力可用性；不是任意群聊都支持 Facilitator |
| Dify | [模型供应商](https://docs.dify.ai/en/cloud/use-dify/workspace/model-providers)；[Logs](https://docs.dify.ai/en/cloud/use-dify/monitor/logs)；[检索测试](https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval) | 模型配置归属、对话/运行日志、用量、测试检索入口 | 实际模型稳定性与性能，完整运行界面 |
| OpenHands | [Agent Canvas](https://docs.openhands.dev/openhands/usage/agent-canvas/overview) | 会话、后端、工作区、模型及当前/旧产品区分 | 本轮未安装运行；不为其成功率背书 |
| LangSmith | [Studio](https://docs.langchain.com/langsmith/studio)；[Observability](https://docs.langchain.com/langsmith/observability-concepts) | Run/Trace/Thread、Graph/Chat 两种详细程度 | 当前收费方案与账户权限、实际运行体验 |

## 公开页面的视觉证据

Playwright 使用 1440×1000 查看三处官方页面。产物在本地忽略目录 `data/research/product-benchmark-2026-10-15/`，没有竞品账号或密钥。

- `linear-official-example.png`：来自任务委托文档的局部示例图，已查看；不是完整产品屏幕。
- `linear-public-page.png`：官方任务分配文档。
- `dify-public-page.png`：供应商文档，示例图片未正常加载；只确认文档结构。
- `taskade-public-page.png`：多 Agent 教程，部分示例图片未加载；只确认教程结构。
- `capture.json`：页面、标题与取得的证据类型。

因此不提供像素级竞品设计评比。应用对象关系、操作路径与模块职责有文档支持；本项目的配色、间距、品牌和响应式规则是建议设计，需后续原型与用户体验验证。

## 本项目证据

- [既有 UI 评审](../../reviews/UI-DESIGN-AUDIT-2026-10-13.md)：全局结构、导航、资源页、状态及操作层级问题。
- [多人协作样例与实测](../../testing/AGENT-COLLABORATION-SAMPLE.md)：已邀请账号与 Agent；需求/记忆有记录；编码失败；第二人实际发言未代替验证。
- `plugins/ai-todo/index.ts`：当前主要待办载荷是 text/done，不能把它描述成成熟任务追踪系统。
- `packages/impl/space-agent-runtime/`、`plugins/agent-inbox/`：执行、工具工作记录、来源关联与消息扫描机制已存在。
- `packages/client-ui/space-client-ui-teamspace/client/agent-operations.ts`：最近处理与全队消息概览已存在。
- 最新供应商页面：统一 footer 与单一测试反馈已修复。此前截图用来说明问题形成过程，不作为该缺陷仍存在的证据。

本报告区分三类证据：官方公开能力、本项目已观测事实、本次建议。未进行竞品付费模型试验，不把规划写成已实施能力。
