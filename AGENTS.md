# AGENTS.md

> ## 👉 开工先读：[`.rules/IRON-RULES.md`](.rules/IRON-RULES.md)（铁律**唯一出处**）
> ## 👉 上手 / 跑起来：[`README.md`](README.md)　架构图：[`docs/architecture.html`](docs/architecture.html)
> ## 👉 接下来做什么：[`docs/ROADMAP.md`](docs/ROADMAP.md)（M1 与**前置门槛**）
>
> 本文件是**开工第一份要读的东西**。它只放铁律的**指针与约束**，不复制正文 ——
> 复制会漂移（同类工程在 Python 版上吃过「同一份名单四处各写一份」的亏）。

---

## 一、铁律（不可协商，原文见 `.rules/IRON-RULES.md`）

1. **web 端 UI 禁止手写 / 自制样式。**
   必须走统一组件库 + 设计令牌，样式封装越简洁越好；
   用的时候只「new」，不「现写」。**不能用「先写出来再重构」绕过。**
   组件库选型未定之前，不许开始写界面代码。

2. **开发过程必须让人类「看得见」，不许自己闷头搞。**
   「干了什么、效果怎么样」要能从控制台 / web UI 看到 —— **只在对话里说的结论等于没说**；
   跑过的门禁 / 迁移要留可查记录；长任务分段交还控制权，不连续推进。

> 后续铁律：**正文只写进 `.rules/IRON-RULES.md`**，这里只加一行清单项。

### 开工前

- [ ] 读 `.rules/IRON-RULES.md`
- [ ] 要动 web 界面吗？→ 组件库选型定了吗？样式来源是不是只有「组件库 + 令牌」？
- [ ] 要写的东西，官方 / 组件库有没有现成的？
- [ ] **这活儿干完，人从哪个页面的哪个位置能看到？**（铁律 2）

### 提交前

- [ ] 界面改动没有引入内联样式、自写样式块、硬编码颜色
- [ ] 结论都带观测点（端口 + 页面 + 表名 / 日志关键字）；跑过的门禁 / 迁移留有可查记录（铁律 2）
- [ ] 调试控制台 5172 仍可达、仍反映真实状态（铁律 2）
- [ ] 新增行为有**会红的**断言

---

## 二、关键入口

细节见 `README.md`，这里只列开工必须知道的口径。

| 项 | 值 |
|---|---|
| 启动（前台常驻） | `npm start` 或 `./scripts/run.sh` |
| 开发（改代码自动重启） | `npm run dev` |
| 停止 | `npm run stop`（`./scripts/stop.sh --check` 只查不杀） |
| 类型检查 | `npm run typecheck` |
| **环境变量（端口唯一出处）** | `.env`（模板 `.env.example` 入库，`.env` 不入库） |
| 后端 | **8080** · 健康检查 `GET /healthz` |
| 调试控制台（测试用，无登录） | **5172** · **已启用**，插件 / 日志 / 数据库三个页面 |
| 控制台 / 团队空间前端 | **5173 / 5174**（尚未启用） |
| Node | **≥22.5 必需**（`node:sqlite`）；本机用 `/home/ia3000/SPM/.toolchain/node24`，v20.17.0 保留未删 |
| 铁律 1 门禁 | `npm run lint:styles`（铁律 1 的四条断言，违反会以退出码 1 结束） |
| **依赖方向门禁** | `npm run lint:deps`（断言 ①②⑦：方向矩阵 / seam 无 IO / 包一律私有） |
| **控制台可达门禁** | `npm run check:console`（断言 ⑩：5172 三页 HTTP 200，需服务在跑） |
| 插件组合清单 | `packages/bundle/*/cordis.patch.yml` + `profiles/*/cordis.patch.yml`；由 `src/compose.ts` 合成运行清单 |

> ⚠ 端口只在 `.env` 定义一次，代码 / 清单 / 脚本全部从它取值，谁都不得自带默认数字。
> `scripts/env.sh` 少了变量会**直接拒绝启动**——这是刻意的，不要改成「用默认值兜底」。

---

## 三、这个仓库是什么

**多人 + 多 Agent 团队协作系统**，基于 cordis 元框架，一切皆插件。
当前是**可运行的空骨架**：框架跑得通，功能插件尚未开发。

- 架构图：`docs/architecture.html`（启动链路 + 运行时结构）
- 框架启动代码只有 `src/index.ts`，**零业务**；所有能力都往 `plugins/` 里加

---

## 四、目录约定

| 路径 | 作用 |
|---|---|
| `src/` | **只放启动代码**，不许塞业务 |
| `plugins/` | **叶子插件**：不需要 seam、也不会被策略包裹，一个目录一个 `index.ts` |
| `packages/seam/` | **能力缝**：只有 `Service` 声明 + 词汇类型，零实现零 IO（当前 13 个，全是空壳） |
| `packages/impl/` | 实现层（可换后端，如 sqlite / 内存） |
| `packages/policy/` | 策略层（只包裹能力，不实现能力） |
| `packages/client-ui/` | 前端，一区一包 |
| `packages/bundle/` | 组合层（只写 `cordis.patch.yml` 清单，不写代码） |
| `dev-cordis/` | 模块划分规范（`MODULE-PLAN.md`）与调研记录 |
| `packages/bundle/*/cordis.patch.yml` | 基础插件组合清单 |
| `profiles/*/cordis.patch.yml` | 按运行场景增补、覆盖或禁用插件 |
| `composed.cordis.yml` | `src/compose.ts` 生成的运行清单，不手改 |
| `config/app.yml` | 框架自身参数（应用名、loader 去哪读清单）；**不含端口** |
| `scripts/` | 所有运行脚本（`env.sh` 是公共前置） |
| `.rules/` | 铁律正文 |
| `docs/` | 文档 |

> `plugins/` 与 `packages/` 的分工：前者是「没有缝」的叶子，后者是「有缝」的（需要被别人替换实现、或被策略包裹）。
> 层与层之间的依赖方向由 `npm run lint:deps` 强制，表在 `dev-cordis/MODULE-PLAN.md` 第 3.7 节。