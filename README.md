# teamspace-cordis

多人 + 多 Agent 团队协作系统。记住这条主线，就能快速找到代码：

> **`seam` 定义能力 → `impl` 实现能力 → `plugins` 接入行为 → `bundle` 组合系统**
>
> UI 在 `client-ui`，策略在 `policy`；启动代码只负责组装和启动，不放业务。

## 先看这张地图

```text
teamspace-cordis/
├── src/                         启动入口与清单合成
│   ├── index.ts                 启动 Cordis
│   └── compose.ts               合并 bundle 与 profile 清单
├── plugins/                     服务端功能：API、认证、Agent、消息、检索……
├── packages/
│   ├── seam/                    能力契约（接口 / 类型）
│   ├── impl/                    契约实现（SQLite、LLM、Agent runtime、工作区）
│   ├── policy/                  横切策略（如授权）
│   ├── client-ui/               前端页面包与共享 UI
│   └── bundle/                  按产品组合插件
├── profiles/                    运行配置层：debug、teamspace
├── scripts/                     启动、构建、门禁、验证和备份
├── config/                      框架基础配置
├── dev-cordis/                   分层设计与模块计划
├── docs/                         架构、路线图、评审记录
├── .rules/                       项目铁律（开发前必读）
├── archive/                      临时脚本与备份归档
├── data/                         本地数据库、日志、上传和 Agent 工作区
├── .env.example                  本机环境配置模板
└── package.json                  依赖与 npm 命令
```

### 找代码时记住四句话

| 要做什么 | 从哪里找 | 记忆点 |
|---|---|---|
| 增加一种可替换能力 | `packages/seam/` + `packages/impl/` | **契约与实现分开** |
| 增加一个业务行为 | `plugins/<name>/` | **一个插件承接一个行为** |
| 选择一组功能一起运行 | `packages/bundle/*/cordis.patch.yml` | **bundle 是插件组合清单** |
| 选择运行配置 / 表面 | `profiles/*/cordis.patch.yml` | **profile 在组合时叠加** |
| 修改前端 | `packages/client-ui/` | **沿用共享组件和设计令牌** |
| 找规则或架构依据 | `.rules/IRON-RULES.md`、`docs/ARCHITECTURE.md` | **先读规则，再改代码** |

## 插件是怎么启动的

```text
packages/bundle/*/cordis.patch.yml ─┐
                                    ├─ src/compose.ts → composed.cordis.yml
profiles/*/cordis.patch.yml ────────┘                         │
                                                             ↓
                                                     src/index.ts → Cordis
```

`composed.cordis.yml` 是启动时生成的运行产物，不要手改。新增或停用插件，应改对应 bundle 或 profile 的
`cordis.patch.yml`。`src/` 保持启动职责，业务逻辑放插件或对应的 package。

## 本地运行

需要 Node.js **22.18 或更高版本**。在仓库目录执行：

```bash
npm ci                     # 按 package-lock.json 安装锁定依赖
cp .env.example .env       # 按需填写本机配置；.env 不入库
npm run migrate            # 首次运行或迁移变更后
npm start
```

修改依赖或 workspace 包清单后运行 `npm install` 并提交更新后的 lockfile；npm 会强制要求 Node.js ≥22.18.0。

使用 `npm start` 或 `npm run dev` 启动服务；支持 `flock` 的环境会阻止同一 `APP_PORT` 的多个实例并发启动。
可先运行 `npm run stop -- --check` 查看服务与遗留 watcher，再用 `npm run stop` 清理本地进程。
服务端口只在 `.env` 配置；启动后可查看 `.env` 中对应的
`APP_PORT`、`DEBUG_PORT`、`CONSOLE_PORT` 和 `TEAMSPACE_PORT`。健康检查路径为 `/healthz`。

常用检查：

```bash
npm run gate:static       # 本地快速检查；无需启动服务
npm start                  # 启动后端和 Web 页面
npm run gate:runtime      # 隔离运行时验收；自动启动临时服务
npm run gate               # 在隔离环境运行 static 与 runtime 两组门禁
npm run verify:ui          # 浏览器交互验收；需要服务和可用 Chromium
```

其他入口：`npm run stop` 停止服务，`npm run backup` 备份数据库、日志、上传和团队共享文件；Agent 私有工作区需显式运行 `npm run backup -- --include-workdirs`（可能占用较多磁盘）。
生产发布步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 改动前先记住这些边界

- **分层方向**：遵守 L0–L12 依赖方向；边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，静态检查为 `npm run lint:deps`。
- **UI 样式**：遵循 [`IRON-RULES.md`](.rules/IRON-RULES.md) 中的组件和令牌约束；不要在业务页面自行造样式。
- **端口与凭据**：端口及机器配置放 `.env`；更新配置项时同步维护 `.env.example`。不要提交 `.env`。
- **本地数据**：`data/` 存数据库、日志、上传和工作区内容，属于运行数据，不应提交。
- **改动可查**：项目规则要求开发结果可观测；运行门禁或迁移后按规则留下记录。

## 继续了解

- [`AGENTS.md`](AGENTS.md)：仓库入口与开发指引
- [`.rules/IRON-RULES.md`](.rules/IRON-RULES.md)：不可绕过的项目约束
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：分层模型与依赖方向
- [`dev-cordis/MODULE-PLAN.md`](dev-cordis/MODULE-PLAN.md)：模块职责与规划
- [`docs/ROADMAP.md`](docs/ROADMAP.md)：阶段计划和前置条件

CI 平台接入、变更预算与独立审批设置见 [CI 文档](docs/CI.md)。

## 当前开发进度（2026-10-16）

本节记录本次公开快照中的代码与验收状态。**代码合入 GitHub 不代表它已部署到正在运行的服务。** 截至本次浏览器检查，Browser Use 对 `http://localhost:5172` 和 `http://localhost:5174/teamspace` 均观察到 `ERR_CONNECTION_REFUSED`；尚无可用运行服务可做端到端确认。

### 已合入本快照

- Agent 原生工具调用与现有 DSML 解析兼容：本地提交 `502db2e`。工具清单沿 Cordis 插件注册，保留 DSML 作为兼容路径。
- 多文件工程完整性检查、C++ 工程隔离编译运行、发布到团队共享工作区：提交 `ac37174`、`a1784e5`、`3db99b9`，并在本快照中完成集成。发布迁移编号为 `0039`，避免与工程校验和 C++ 执行迁移冲突。
- 目标协作流程：Agent A 在个人工作区生成包含 `helloworld.cpp`、头文件、实现文件、`CMakeLists.txt` 和 `README.md` 的工程；A 显式调用 `tool.workspace.publish` 发布整个 `projects/<工程名>/`；Agent B 用 `tool.workspace.read` 且指定 `scope="shared"` 读取源码。仅发布者的个人工作区仍不可被 B 直接读取。
- 添加了多文件共享的 Gherkin 场景，覆盖完整发布、Agent B 读取、个人区隔离，以及路径、符号链接、大小限制和目标冲突拒绝。
- 知识库检索相关性修复 `78fc14b` 已合入：查询按标题/正文筛选，避免无关语义块被误报为命中。
- Agent 中继人工确认 `2d3de78` 已合入：中继回复需经过人类审阅确认；独立分支报告 AS11 浏览器验收通过。
- 本工作树通过：`npm run typecheck`、`verify:agent-bootstrap`、`verify:agent-teamspace`、`verify:upgrade-fixtures`、`verify:sandbox`、`verify:project-completeness`。其中沙箱验证实际运行了多文件 C++ 编译/执行和共享发布/读取检查。

### 其他已完成但尚未合入的本地分支

下列提交仍只在本地独立工作树，尚未发布到默认分支，也未在当前运行服务上确认：

- DRI 指派与转交及无 DRI 时群主决策 `aee9c02`、`c34d277` 已合入；成员列表/决策命令/决策展示的本地验证通过。其余 DRI 收尾与角色权限提交 `a4004a6`、`4c091c8` 因与已合入决策 UI 重叠而未合并。
- 会话历史搜索 `ac03f0c`、当前会话待办只读工具 `226de27`、成员数/清单同步 `98fda9b` 均因与合入的 Agent、知识库、决策 UI/工具配置发生多文件冲突，尚未合并。
- 消息校验提示 `d19de09`（空消息反馈）、`a5aeae4`（拒绝纯空白消息）、`6b15607`（超长消息提示）与同一聊天 UI/浏览器验收脚本重叠，尚未合并。

### 仍待处理

- 对上述分支做无损合并并补齐集成检查；冲突或行为重叠的改动仍需逐项审查。
- `npm run verify:compatibility` 当前有 10 项未登记的兼容性变更（0036/0039 迁移与 6 个 seam 文件）；发布前需补齐逐项的版本、升级/回滚说明和验证记录。
- Browser Use 当前无法连接本机服务，因此尚未完成真实 UI 流程的截图验收；也尚未确认共享工程已在 `5172` 服务中可用。
- 知识库“无关查询仍命中结果”、DRI 决策入口可达性、重复成员展示、消息边界反馈等 QA 发现，须在对应改动合入并部署后重新复测。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

## 交互式项目文件地图

从仓库根目录运行：

```bash
npm run tree:html
```

生成的独立页面位于 `data/dev/project-tree.html`。页面以全屏画布展示可展开的层级关系图：可以拖动画布、缩放、搜索并定位模块；双击节点或使用键盘方向键展开层级，选中文件或目录可查看职责说明。生成器从 Git 文件清单自动更新层级，尊重 `.gitignore`，只读取路径和文件名，不读取源码内容，并额外排除 `.env`、数据库和运行数据。页面结构和交互模板位于 `scripts/project-tree-atlas.template.html`。

需要在地图上记录开发意图、标签并查看 Git 改动时，启动本机交互服务：

```bash
npm run tree:dev
```

终端会显示本机地址。服务只绑定 `127.0.0.1`；选中文件或目录后可创建关联多个节点的规划卡，支持待办、进行中、完成、阻塞状态与自定义标签。卡片共享数据保存在 `scripts/project-tree.annotations.json`。地图按当前 HEAD 高亮工作区变动，支持查看统一格式 diff；页面不会执行 Git 写操作。按 `Ctrl+C` 停止服务。静态页面仍通过 `tree:html` 生成，不带本机编辑和 diff 功能。

配色、模块匹配和职责说明集中在 [`scripts/project-tree.metadata.json`](scripts/project-tree.metadata.json)：新增普通文件会自动出现在树中；新增需要独立颜色/说明的模块时，只需在此配置中增加路径规则和描述，不用修改生成器逻辑。关键文件的专属解释放在 `fileDescriptions` 中；其他文件会根据文件名和所在层级生成通俗提示。不够准确时，也可按路径补一条专属说明。也可指定其他仓库根目录或输出位置：

```bash
node scripts/project-tree-html.mjs --root /path/to/repo --out /path/to/project-tree.html
```

验证生成器能自动发现新文件、读取模块元数据并排除本地运行数据：

```bash
npm run verify:project-tree-html
```

验证本机规划卡保存、路径校验和 Git 工作区差异读取：

```bash
npm run verify:project-tree-workbench
```
