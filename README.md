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

`composed.cordis.yml` 是生成物，不要手改。新增或停用插件，应改对应 bundle 或 profile 的
`cordis.patch.yml`。`src/` 保持启动职责，业务逻辑放插件或对应的 package。

## 本地运行

需要 Node.js **22.5 或更高版本**。在仓库目录执行：

```bash
npm ci                     # 按 package-lock.json 安装锁定依赖
cp .env.example .env       # 按需填写本机配置；.env 不入库
npm run migrate            # 首次运行或迁移变更后
npm start
```

修改依赖或 workspace 包清单后运行 `npm install` 并提交更新后的 lockfile；npm 会强制要求 Node.js ≥22.5.0。

开发时用 `npm run dev`。服务端口只在 `.env` 配置；启动后可查看 `.env` 中对应的
`APP_PORT`、`DEBUG_PORT`、`CONSOLE_PORT` 和 `TEAMSPACE_PORT`。健康检查路径为 `/healthz`。

常用检查：

```bash
npm run gate:static       # 本地快速检查；无需启动服务
npm start                  # 启动后端和 Web 页面
npm run gate:runtime      # 完整运行时验收；需要服务已启动
npm run gate               # 依次运行 static 与 runtime 两组门禁
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
