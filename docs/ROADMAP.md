# 路线图（ROADMAP）

> 本文件是**「接下来做什么、做到什么程度算完」的唯一出处**。
> 铁律见 [`.rules/IRON-RULES.md`](../.rules/IRON-RULES.md)　·　怎么跑起来见 [`README.md`](../README.md)
> 建档：2026-09-27

---

## 现状

**M1 已完成**（2026-09-27）：调试控制台在 5172 跑起来了，三个页面都是真实运行时数据。

- `src/index.ts` 只做启动，零业务
- 业务插件：`plugins/health`（`GET /healthz`）、`plugins/app`（试金石，打印一行日志）
- 设施插件（`cordis.yml`）：`server`(8080) + `debug-server`(5172) + `debug-webui`
  + `plugin-loader-webui` / `plugin-logger-webui` / `plugin-database-webui` + `plugin-database(-sqlite)`

---

## M1　最基础的插件 + 调试控制台　✅ 已完成

### 需求原文（用户指示，2026-09-27）

> 然后,接下来是开发最基础的插件组件了，比如，插件系统查看插件，日志系统插件，数据库系统插件，这个插件极其的基础，
> 必须要求，我可以在后端的 web 控制台美观的看到这些页面（调试用）（初步设计不需要登录验证，直达的，建议放在5172端口）

### 要什么（与交付方式的对照）

| # | 交付物 | 实际怎么做 |
|---|---|---|
| 1 | 插件查看插件 | 用官方 `@cordisjs/plugin-loader-webui`，扫描 node_modules 里带 `cordis` 字段的包，实测列出 11 个插件及运行状态 |
| 2 | 日志系统插件 | 用官方 `@cordisjs/plugin-logger-webui`，日志落到 `data/logs.db`（sqlite），页面可按级别筛选 + 搜索 |
| 3 | 数据库系统插件 | 用官方 `@cordisjs/plugin-database` + `-sqlite` 驱动 + `-webui` 页面 |
| 4 | web 调试控制台 | 5172，挂第二个 `@cordisjs/plugin-server` 实例，`isolate: { server: debug }` 与后端 8080 隔离 |

**为什么全是官方包**：这三个页面官方生态里 1:1 现成，且每个包预置了 `dist/manifest.json`。
我们**写的 UI 代码是 0 行** —— 这是铁律 1 能成立的结构性原因，详见
[`.rules/IRON-RULES.md`](../.rules/IRON-RULES.md) 的选型表。

### 硬性要求

- **美观**——不是「能看就行」。走统一 UI 组件库、主题一致，见**铁律 1** ✅
  由 `@cordisjs/client` 外壳统一提供（element-plus + uno 令牌），我们没有自写样式
- **无登录、直达**——初期不做鉴权，浏览器打开 5172 直接进 ✅
  （原文「初步设计不需要登录验证」，即**后续会加**，不是永久不要）
- **开发态 / 生产态** ⚠ **与原计划不同，已与用户确认改为只用生产态**
  原计划「开发态由 Vite 提供在 5172」实测行不通：`devMode` 下 webui 临时起 Vite 去编译
  `@cordisjs/client` 的源码，`theme/menu/menu.vue` 编译失败、页面全白
  （报错原文：`No fs option provided to compileScript in non-Node environment`，2026-09-27）。
  改为 `devMode: false` 走各包预构建产物 —— 我们零 UI 代码，本来也不需要前端 HMR。

### 前置门槛：不满足则 M1 禁止开工　✅ 已全部满足

> 用户原话：**以上的内容必须是根本的前提，如果上方的内容无法做的完美，不符合我的预期，就禁止下面的事情进行**

- [x] 铁律 1 的**组件库选型已定**：`@cordisjs/components` + `element-plus` + `uno`（写进选型表）
- [x] 设计令牌的出处已定：由 `@cordisjs/client` 外壳统一注入，本仓库不新增令牌文件
- [x] 样式门禁断言已建（`npm run lint:styles`），且**三种改坏方式都实测会红**

### 验收标准

- [x] 浏览器打开 `http://localhost:5172` 直接看到控制台，**无需登录**
- [x] 三个页面都能看到**真实运行时数据**
  - 插件页：列出 11 个插件 + 运行状态
  - 日志页：真实日志（含 `server listening at 0.0.0.0:8080` 与 `:5172` 两条）、级别筛选 + 搜索
  - 数据库页：页面连通、可列表可查询；当前显示 **0 张表**，因为**确实还没定义任何数据模型**
    （属真实状态，非故障。`data/database.db` 由驱动建立，待 M2 定义表后即可见）
- [x] 三个页面的样式里**没有**内联样式、自写样式块、硬编码颜色（门禁 ① ② ③ 覆盖）
- [x] 端口 5172 来自 `.env`（`DEBUG_PORT`），`cordis.yml` 里只有 `process.env.DEBUG_PORT ?? 5172`
      这一处兜底默认值，没有第二个写死的地方
- [x] 新增行为都有**会红的**断言：`scripts/lint-styles.sh` 四条断言 + `scripts/env.sh` 的 Node 版本下限

### 端口

唯一出处是 `.env`：`DEBUG_PORT=5172`。

口径：后端 `8080` / **调试控制台 `5172`（测试用）** / 控制台 `5173` / 团队空间 `5174`。

> ⚠ 5172 是**新开**的测试端口，与既有的正式控制台 `5173` **并存**，不是替换它。别把两个搞混。

---

## 待定项

| 项 | 状态 |
|---|---|
| 组件库选型 | ✅ 已定（官方 webui 栈，见铁律 1 选型表） |
| 控制台鉴权 | ⬜ 初期不做；何时加、怎么加 待定 |
| 日志插件：自研还是用 cordis 生态现成的 | ✅ 用官方的（`plugin-logger-webui`） |
| 数据库插件：选型（驱动 / 迁移工具） | 🔶 驱动已定 `@cordisjs/plugin-database-sqlite`；**迁移 / 种子机制**待定 |
| 数据库页「0 张表」 | ⬜ 待定：是否先定义第一张真实业务表（不做假数据） |
| Node 运行时 | ✅ 已升到 v24.21.0（`.toolchain/node24`，v20.17.0 保留）；`node:sqlite` 要求 ≥22.5 |
| webui `devMode` | ⬜ 待定：将来若要改官方页面源码，需要先解决 `createVite` 的 fs 问题 |
| M2 及以后 | ⬜ 待规划（见 `.mydoc/我的计划.md` 末条：模块规划文档存 `dev-cordis/`） |

---

## 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-27 | 建档，写入 M1（最基础的插件 + 调试控制台）与前置门槛 |
| 2026-09-27 | M1 完成：三个页面跑通；前置门槛全部满足；`devMode` 改为 `false`（Vite 路线实测不通）；Node 升到 24 |