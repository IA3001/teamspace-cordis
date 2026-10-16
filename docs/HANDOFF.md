# Teamspace Cordis 项目交接

更新日期：2026-10-16（Asia/Shanghai）
仓库：[IA3001/teamspace-cordis](https://github.com/IA3001/teamspace-cordis)
许可证：Apache-2.0
本次交接分支：[handoff/sync-20261016](https://github.com/IA3001/teamspace-cordis/tree/handoff/sync-20261016)，文档提交后应以该分支最新提交为准。

## 一句话说明

这是一个基于 Cordis 的多人、多 Agent 团队协作系统。当前工作的核心目标是让 Agent 在隔离的个人工作区编写多文件项目，由 Agent A 显式发布到团队共享工作区，再让 Agent B 从共享区拉取并实际读取；同时把模型能力接入统一的 tool 调用路径，并保留 DSML 兼容。

## 来龙去脉

1. **先摸清项目结构并做真实 QA。** 活跃项目在 `teamspace-cordis/`；旧 `teamspace/` 已弃用。项目按 Cordis 插件、可替换 seam/impl、policy、client-ui 和 bundle 分层。最初的验收围绕会话、成员、DRI 决策、待办、工作区以及登录和消息反馈展开。浏览器测试曾暴露成员数与名单不一致、旧 token 被误报为有效、消息边界反馈不足等问题。
2. **明确 Agent 工作区协作目标。** 用户要求的不只是上传一个 `helloworld.cpp`，而是完整的小型工程：Agent A 在个人工作区创建多个源文件、头文件、构建文件和 README；A 把整个工程发布到全局/团队工作区；B 从共享区取回并成功读取。个人工作区必须继续隔离，不能因为共享功能而被其他成员直接读取。
3. **明确模型接入方向。** 项目采用系统内的 tool 调用，并兼容既有 DSML 输出解析；不新增独立 MCP 进程或端口作为产品依赖。真实模型驱动的演示仍需真实凭据和完整 UI 验收，不能用 stub 回复冒充。
4. **准备开源交接。** 用户选择 Apache-2.0。交接期间在独立工作树整理 README、兼容性记录、handoff 文档和已确认修复；默认分支不改写。用户要求紧急同步后，已把 30 个本地分支头分别强制同步到 `local-sync/20261016/...`，另将集成快照发布到 `handoff/sync-20261016`。这些是分支快照，不代表每个分支已通过完整门禁或已合并到默认分支。

## 当前应该从哪个分支开始

GitHub 默认分支在本次同步时仍是旧快照：`rebuild-20261009` 指向 `34265f0`；`master` 指向 `39cd6a7`。本次交接集成快照为 `handoff/sync-20261016`，提交 `bcf2e81`。**新同事请先检出交接分支，不要把默认分支误认为最新整合状态。**

```bash
git clone https://github.com/IA3001/teamspace-cordis.git
cd teamspace-cordis
git fetch origin
git switch --track origin/handoff/sync-20261016
```

在 `local-sync/20261016/` 下还同步了 30 个本地分支头，名称保留在前缀后面，例如：

```bash
git switch --track origin/local-sync/20261016/feat/session-history-search-tool-20261016
git switch --track origin/local-sync/20261016/feat/session-todo-read-tool-20261016
git switch --track origin/local-sync/20261016/fix/dri-decision-ux-20261016
```

查看完整列表：<https://github.com/IA3001/teamspace-cordis/branches/all?query=local-sync%2F20261016>。不同本地分支可能指向相同提交，也可能是较早基线；同步分支引用只保证对象可查看，不表示所有分支内容已集成或互相兼容。不要把它们一次性合并。

## 目前已集成到交接快照的内容

- 原生 tool-call 路径与 DSML 兼容处理；Agent 运行通过 Cordis 插件注册能力。
- Agent 私有工作区工程完整性检查，含多文件、路径、符号链接、大小和冲突边界；沙箱验证支持受控 C++ 编译/运行。
- Agent A 发布整个工程到共享工作区，Agent B 以 `scope="shared"` 读取；个人工作区保持隔离。对应 Gherkin 在 `docs/acceptance/gherkin/03-agents-and-workspaces.feature`。
- 知识库检索相关性改进，以及 Agent 中继回复的人类确认门。
- DRI 指派/转交及未单独指定 DRI 时的群主决策路径。
- 登录页会实际校验已有 token；空白/超长消息反馈和会话成员计数修正。
- 模型长流结束后的用量回执不再产生空文本帧；P8 验收按函数复杂度拆分，原断言经独立审查未发现删改。
- Cordis 调试控制台首页空白问题已修复，现有欢迎卡能跳转插件、运行日志和数据库页。
- README 项目地图和本交接说明。

## 验证证据与边界

**已通过的定向检查：**

- `npm run typecheck`
- `npm run verify:p8`：69 通过，0 失败
- `npm run verify:compatibility`：0 项违规
- `npm run verify:docs`：0 项新违规，8 条旧链接被跟踪
- `npm run verify:admin-ui`：后台首页、三个入口跳转及后台 UI 回归通过
- 另有 Agent bootstrap/teamspace、升级 fixture、多文件工程完整性和沙箱等专项验证通过。沙箱覆盖了多文件 C++ 编译/运行及共享发布/读取机制。

Browser Use 在隔离环境里实际完成了注册用户、建会、发送并查看消息；调试台首页及插件/日志/数据库路由也实际点击验证。**这不是 Agent A/B 的真实模型演示。** 当前隔离环境没有模型凭据；没有真实模型生成的 A 项目，也没有在浏览器中看到 B 拉取后的聊天/工作区截图。

`npm run gate:related -- origin/rebuild-20261009` / 完整 UI 门禁没有通过。最后一次确认的问题包括：活动消息中的人类与 Agent 作者仍会显示原始 ID；工作区文件树验收需要可靠地准备一个确实已有工作区的 Agent，并验证文件 Tab 实际加载目录。AS6 未读定位用例也发现过 seed 不足的问题。修复子代理在用户要求下已停止；其 UI 代码和验收脚本改动留在本机工作树未提交，**不在 GitHub 的 30 个分支快照内**。团队接手时应重新检查并从干净交接分支修复，不能把这项工作当作已完成。

推送新快照时，用户明确要求忽略 pre-push 门禁，因此强制推送绕过了该 hook。上面通过的定向检查是真实结果，但**本次交接分支并未获得完整 `npm run gate` / `npm run verify:ui` 通过**；请在合入默认分支前复跑项目门禁并审查差异。

## 30 个同步分支的主题

以下名称映射为远端 `local-sync/20261016/<本地分支名>`：

- Agent 共享工作区发布：`feat/agent-workspace-publish-20261016`、`fix/agent-workspace-publish-runtime-20261016`
- Agent 工程完整性与原生 tool 调用：`fix/agent-project-completeness-20261016`、`fix/agent-native-tool-calls`
- 会话历史搜索和待办只读工具：`feat/session-history-search-tool-20261016`、`feat/session-todo-read-tool-20261016`
- DRI 与角色流程：`fix/dri-assignment-flow-20261016`、`fix/dri-decision-closure-20261016`、`fix/dri-decision-ux-20261016`
- 消息与会话反馈：`fix/blank-message-feedback-20261016`、`fix/blank-message-whitespace-20261016`、`fix/message-length-feedback-20261016`、`fix/session-member-roster-count-20261016`
- 知识库：`fix/kb-empty-query-source-20261016`、`fix/kb-search-false-positives-20261016`、`fix/kb-search-relevance-20261016`
- 登录、流式输出、发布资料：`fix/login-token-validation-20261016`、`fix/p8-streaming-18000-20261016`、`fix/split-verify-p8-part-e-20261016`、`fix/release-metadata-compat-20261016`
- 中继确认及其他：`fix/relay-confirmation-human-gate-20261016`、`fix/workspace-history-auth`、`fix/todo-pending-count-sync-20261016`、`fix/real-provider-workspace-dsml-20261016`
- 检查与交接快照：`fix/debug-console-root-home-20261016`、`fix/ui-gate-failures-20261016`、`integration/handoff-pending-20261016`、`handoff/open-source-20261016`，以及 `master`、`rebuild-20261009` 的本地头快照。

个别分支存在相同提交指针或较旧基线；请用 `git log --oneline --graph --decorate` 和 GitHub Compare 核对后，再挑选需要的提交。`handoff/sync-20261016` 是本次已整合文档和代码快照的首选入口。

## 本机启动与数据

需要 Node.js 22.18 或更高版本；Agent 执行代码的场景还需要 Docker Engine。每位开发者使用自己的 `.env`、数据库和模型凭据：

```bash
npm ci
cp .env.example .env
# 在本机 .env 设置密钥、路径和端口
npm run migrate
npm start
```

端口从 `.env` 读取；示例环境曾使用后端 `8080`、调试控制台 `5172`、Teamspace `5174`。请以自己 `.env` 中的值为准。健康检查 `/healthz`。本次浏览器使用的账户、会话和数据库都是隔离验收数据；没有上传到 GitHub，也不是用户原有后台数据。不要提交 `.env`、数据库、日志、上传内容或 Agent 工作区。

## 建议接手顺序

1. 阅读 `AGENTS.md`、`.rules/IRON-RULES.md`、`docs/ARCHITECTURE.md` 和 `docs/acceptance/gherkin/03-agents-and-workspaces.feature`。
2. 从 `handoff/sync-20261016` 新建团队自己的功能分支；先检查这个快照的完整门禁状态，别直接并入默认分支。
3. 恢复或重写作者名称映射和工作区树 UI 用例：作者显示需要使用实际显示名/Agent 标题；文件树场景要先创建/选中具有真实目录的 Agent 工作区，再断言滚动与轮询状态。
4. 运行 `npm run gate:related -- origin/rebuild-20261009`；问题修完后执行 `npm run gate` 和 `npm run verify:ui`，保留输出和浏览器截图。
5. 配置可用的真实模型，在隔离数据库中执行 A 创建多文件小项目 → A 发布到共享区 → B 读取并引用具体源码的完整场景，保存聊天记录及工作区截图。确认不是 stub/占位模式后，再报告真实协作通过。
6. 会话历史工具、待办只读工具及角色权限分支逐个 review、解决与最新基线的冲突，再开 PR 合并。PR 应列出用户可见变化、检查和截图。

## 开发约定

- 只在 `teamspace-cordis/` 继续开发；不要恢复已弃用 `teamspace/`。
- 遵守 L0–L12 依赖方向。契约放 `packages/seam/`，实现放 `packages/impl/`，业务行为放 `plugins/`，UI 放 `packages/client-ui/`；不要把业务逻辑塞进启动入口 `src/`。
- 修改迁移或 seam 契约时维护兼容性记录；行为变化补 Gherkin/定向验收和可观察证据。
- 本地提交前检查工作区与密钥；团队后续 push 前应正常运行仓库 pre-push 门禁，不沿用本次紧急同步时的 hook 绕过操作。
