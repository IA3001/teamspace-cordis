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
