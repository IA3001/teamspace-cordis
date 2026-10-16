# Teamspace Cordis 开发交接

更新日期：2026-10-16  
仓库：[IA3001/teamspace-cordis](https://github.com/IA3001/teamspace-cordis)  
当前交接基线：默认分支 `rebuild-20261009`，以 GitHub 上的最新提交为准。

## 先拿到可用代码

```bash
git clone https://github.com/IA3001/teamspace-cordis.git
cd teamspace-cordis
git switch rebuild-20261009
git pull --ff-only
```

从该基线创建自己的开发分支，不要直接改默认分支：

```bash
git switch -c feat/<简短主题>
```

仓库采用 Apache-2.0。提交前检查是否包含 `.env`、本地数据库、日志、上传文件或 Agent 工作区；这些机器数据不要提交。

## 本次交接已包含

- Agent 原生 tool call 与 DSML 兼容路径。
- Agent 私有工作区多文件工程完整性检查和受控 C++ 编译/执行。
- Agent A 显式发布整个工程到团队共享工作区，Agent B 通过 `tool.workspace.read` 的 `scope="shared"` 读取；个人工作区仍保持隔离。
- 知识库检索结果相关性过滤。
- Agent 中继回复的人类确认门，以及 DRI 指派/转交和无 DRI 时群主决策流程。
- 项目地图、Gherkin 验收场景和进度记录。

核心协作验收场景是：Agent A 在个人工作区创建一个包含多个源文件、头文件、`CMakeLists.txt` 和说明文件的 C++ 项目；A 发布项目目录到全局工作区；Agent B 从共享区拉取并实际读取文件。对应 Gherkin 场景位于 `docs/acceptance/gherkin/03-agents-and-workspaces.feature`。

## 本地启动

需要 Node.js 22.18 或更新版本；Agent 代码执行场景还需要可用的 Docker Engine。复制 `.env.example` 并填写本机配置，不要共享 `.env`：

```bash
npm ci
cp .env.example .env
# 按需设置本机模型凭据、路径和端口
npm run migrate
npm start
```

端口由 `.env` 管理。启动后先访问 `/healthz`，再从 `.env` 查看实际 Teamspace 端口。架构约束、常用命令和部署细节见根目录 `README.md`、`.rules/IRON-RULES.md` 与 `docs/DEPLOYMENT.md`。

## 已有验证与当前限制

本次集成工作树报告以下定向检查通过：类型检查、Agent bootstrap/teamspace、升级 fixture、多文件沙箱验证、工程完整性、知识库 RAG、决策命令与展示、会话成员相关检查。沙箱验证实际覆盖了多文件 C++ 编译/运行及 Agent A 发布、Agent B 读取共享工程。

交接时还需要先处理这些问题：

1. `npm run verify:compatibility` 有 10 项兼容性记录待补：迁移 `0036`、`0039` 各自的 up/down 记录（4 项），以及 seam `space-agent`、`space-agent-catalog`、`space-agent-inbox`、`space-context`、`space-orchestrator`、`space-workdir`（6 项）。按项目兼容性流程逐项确认升级/回滚影响和验证证据，不要只为消除报错而编造兼容承诺。
2. 完整 `verify:ui` 尚未完成：当前发布快照缺少该检查需要的 release manifests。先按项目发布流程生成产物，再在隔离服务上跑 UI 验收。
3. 本次 Browser Use 检查时，本机 `5172` 与 `5174/teamspace` 都是 `ERR_CONNECTION_REFUSED`。共享工程功能尚未在运行中的 UI 服务完成端到端截图验收；不要把代码已推送当作服务已部署。

建议接手顺序：先补兼容性记录并跑相关检查；准备 release manifests 和隔离服务；用 Gherkin 场景实际执行 A 发布、B 读取，保存聊天记录与工作区截图；然后逐项复测 DRI、知识库相关性、中继确认和消息边界行为。

## 尚未进入 GitHub 默认分支的改动

以下提交目前只存在于维护者本地的独立工作树，**不能从公开仓库直接 checkout**。需要某项改动时，请先联系维护者将其推送/审查后再集成：

- DRI 决策收尾和角色权限：`a4004a6`、`4c091c8`。
- 会话历史搜索、会话待办只读工具、成员数量同步：`ac03f0c`、`226de27`、`98fda9b`。
- 空消息、纯空白消息和超长消息提示：`d19de09`、`a5aeae4`、`6b15607`。

这些分支与已合入的聊天 UI、Agent 配置和验收脚本有重叠，尚未安全合并。不要根据本文件中的提交短 SHA 假设 GitHub 已包含这些对象。

## 协作约定

- 开发前阅读 `AGENTS.md` 和 `.rules/IRON-RULES.md`，遵守 L0–L12 依赖方向和包边界。
- 行为变更在对应插件/package 中实现；UI 继续使用共享组件和设计令牌。
- 迁移、兼容性登记、Gherkin 场景和验证证据一起维护。
- PR 描述用户可见变化、风险、验证结果；UI 变更附交互截图。
- 提交保持聚焦，按仓库风格使用 `功能:`、`修复:` 或 `docs:` 前缀。
