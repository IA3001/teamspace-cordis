# Agent 开发入口

本仓库采用 Agent-Native 开发流程；适用范围是**开发本项目**，不授权产品内 Agent 改造或自动发布。

先读 [开发流程](docs/development/WORKFLOW.md)，然后按任务读取以下权威来源。不要把历史决策当成当前产品要求；用户已批准的指令优先。

| 要理解什么 | 权威来源 |
| --- | --- |
| 不变式与共享 UI | [.rules/IRON-RULES.md](.rules/IRON-RULES.md) |
| 能力与依赖方向 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 隔离验证、预算、平台保护 | [docs/CI.md](docs/CI.md) |
| 本轮工作与用户方向 | [父目录 TODO](../TODO.md)、[story1](../story1.md)、[story2](../story2.md)、[Problem](../Problem.md) |
| 部署与运维 | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| 源码接口目录 | [生成目录](docs/generated/INTERFACES.md) |

## 开发技能

技能在 `.agents/skills/` 中，根入口主动发现；按需要读取，不一次加载全部。`space-understand` 用于项目理解，`space-plan` 定义范围，`space-implement` 修改，`space-verify` 选择验证，`space-doc-sync` 同步文档，`space-review` 独立审查，`space-handover` 恢复，`space-postmortem` 复盘，`space-release` 准备发布。

## 工作区与命令

业务放 plugins/packages，src 只启动组合；新开发任务使用独立工作树。当前脏改动先盘点归属，不能擅自提交、覆盖或清理。Node >=22.5；用 `npm ci` 保持锁文件。`npm run gate` 是完整隔离验证，相关检查不能替代合并门禁。直接 verify/smoke 可能触及开发实例，自动验收走 gate。

真实端口由任务运行信息与 `.env` 决定；禁止为完成验收另启一个端口后冒充原页面已修复。保持共享组件/令牌与 L0–L12；创建普通 Agent 是产品数据操作，不是新增插件。

变更使用 focused assertion 和负向验证，提交说明写行为与证据。规则弱化、权限扩张、破坏兼容及发布需人工批准；普通改动由独立 Agent 审查。GitHub Actions 是推送后的自动反馈，不代表服务器端拦截或分支保护已启用。凭据只在本地配置，不能写入任务记录、源码、报告或提交。
