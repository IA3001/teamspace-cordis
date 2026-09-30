# teamspace-cordis 模块规划

> **本文是「各个模块怎么切、谁依赖谁、怎么组合」的唯一出处。**
> 铁律见 [`../.rules/IRON-RULES.md`](../.rules/IRON-RULES.md)　·　怎么跑起来见 [`../README.md`](../README.md)　·　做到哪一步见 [`../docs/ROADMAP.md`](../docs/ROADMAP.md)
>
> 建档：2026-09-27 ｜ 状态：**待用户定稿**（第 7 节「待定」清零后转正式）
> 方案：**A. monorepo 多包**（用户选定 2026-09-27）

---

## 0. 结论先行

四句话：

1. **三层骨架**：`seam`（能力缝，只有类型与接口）→ `impl`（实现）/ `policy`（策略，包在实现外面）→ `bundle`（组合层）。
2. **一条依赖方向铁律**：`impl` / `policy` 只能依赖 `seam`，**包与包之间禁止横向依赖**。这条必须能被脚本判红，否则等于没写。
3. **组合不靠 import，靠 patch 叠加**：清单从空根开始，bundle 层往里 `insert`，用户层最后覆盖，**同一行只准出现在「一个 bundle 层 + 用户层」**。
4. **cordis 内核已经替掉了旧系统的 `internal/kernel`**（插件宿主、泛型注册表、服务表、依赖注入、effect 回滚），我们不重造，只在其上定义**业务能力缝**。

判据（判断一个功能该不该拆包）：

> 它**是否需要「换一种实现」或「被策略包裹」**？需要 → 进 `packages/`；不需要 → 就是一个叶子插件，留在 `plugins/`。

---

## 1. 三个参照系

### 1.1 旧 `teamspace/`（Go + Vue）

已跑通业务，模块是**按「元素」和「领域」切的**，不是按技术层切的。

| 模块 | 路径 | 职责 |
|---|---|---|
| 内核 | [`internal/kernel/`](file:///home/ia3000/SPM/teamspace/internal/kernel)（`app.go` / `plugin.go` / `registry.go` / `service.go`） | 插件宿主（`Register`/`Apply`/`Start`/`Stop`/`Reload`）+ 泛型注册表 `NewRegistry[T]` + 服务表。**零业务** |
| 元素（8 个） | [`internal/elements/`](file:///home/ia3000/SPM/teamspace/internal/elements) | `message`（入站消息拦截管线）/ `command`（`/` 指令注册与分派）/ `ui`（面板 manifest）/ `memory`（私有记忆服务接口）/ `tool`（工具注册中心）/ `dialog`（结构化对话流只读扩展点）/ `history`（事件视图过滤器）/ `webroute`（HTTP 路由注册） |
| 领域 | [`internal/domain/`](file:///home/ia3000/SPM/teamspace/internal/domain) | 纯逻辑无 IO：`coordinator`（调度/授权边界）、`event`（事件模型）、`principal`（主体）、`dri_rotation`、`loop_detect`、`evaluation`、`gantt`、`kickoff`、`story`、`summarizer`、`template`、`disposition` |
| 持久化 | [`internal/services/store/`](file:///home/ia3000/SPM/teamspace/internal/services/store) | `migrate` / `migrations` / `seed` / `reset` / `member` / `identity` / `plugins` / `team_account`。10 张表：`users` `auth_sessions` `sessions` `session_members` `events` `plugins` `settings` `meta` `principals` `team_accounts` |
| 推送 | `internal/services/sse/` | 服务端推送 |
| 平台 | `internal/platform/` | 日志、环形缓冲、运行信息、流式、trace |
| 沙箱 | `internal/sandbox/` | 命令沙箱：`audit` / `confine` / `execdir` |
| 工具 | `internal/tools/` | 工具目录 + 注册表 |
| 门禁 | [`gate/`](file:///home/ia3000/SPM/teamspace/gate) | `checks.go` / `secret_scan.go`（CI 期质量门禁，非运行时模块） |
| 前端 | [`web/`](file:///home/ia3000/SPM/teamspace/web) | 三个面：`console`（管理台）、`teamspace-vue`（团队空间）、`shared` |

**两个已经做对、值得原样继承的设计**：

- `elements/command` 的 **Parse / Dispatch 双机制函数**：新增指令 = 注册一个实现，机制零改动（[command.go](file:///home/ia3000/SPM/teamspace/internal/elements/command/command.go)）。
- `elements/ui` 的 **后端只描述「有什么」，前端决定「怎么画」**：后端下发 `Slot/Key/Title/Props` 的 manifest，前端按 key 查自己的组件注册表；**前端不认识 key 时降级占位卡，不白屏**（[ui.go](file:///home/ia3000/SPM/teamspace/internal/elements/ui/ui.go)、[registry.ts](file:///home/ia3000/SPM/teamspace/web/teamspace-vue/src/panels/registry.ts)）。这条正好也是 dsh 的做法。

### 1.2 deepseek-harness（cordis v4，240 个包）

源码在本机：`~/.dsh/profiles/node_modules/@deepseek-ai/`。仓库形状是 `packages/<域>/<包>`。

**三段式**（`dsh-fs` 是最好懂的样例）：

| 角色 | 例子 | 特征 |
|---|---|---|
| **seam（抽象能力缝）** | `dsh-fs`（`ctx.fs`）、`dsh-llm` | 只定义 `Service` 子类 + 词汇类型（branded id、返回形状）+ **错误分类法**（`FsError extends HarnessError`）；只 `peerDependencies`，不含实现。官方描述：「Abstract filesystem capability seam」 |
| **impl（实现）** | `dsh-fs-local`、`dsh-bash-local`、`dsh-llm-deepseek`、`dsh-session-persistence-jsonl` | 实现 seam 定义的服务 |
| **policy（策略）** | `dsh-fs-sandbox`、`dsh-fs-observation-policy`、`dsh-sandbox-policy`、`dsh-spill-policy` | 包在实现外面，不改实现 |
| **bundle（组合层）** | `dsh-base`、`dsh-web-app` | 用 `package.json` 的 `dsh.bundle.patch` 声明自带 patch 文件 |

**组合机制（最值得抄的一条）**——清单是**叠出来的**，不是写出来的：

```
profiles/web/cordis.yml            = []          ← 空根（官方注释：edit cordis.patch.yml, not this file）
  + dsh-base/cordis.patch.yml      （487 行）    ← bundle 层：一个 insert: 挂上全部核心行
  + dsh-web-app/cordis.patch.yml                 ← 面（surface）层：web 相关行
  + profiles/web/cordis.patch.yml  = []          ← 用户层：最后写赢
```

`dsh-base/cordis.patch.yml` 头部把规则写死了（照抄到我们文档，因为它是**约束**不是实现细节）：

- patch **替换目标行的整段 `config`，不是往里合并**；
- 所以「随模式取值不同」的行**不住在 base 里**，它属于各自的模式 bundle；
- **任何一行最多只出现在「一个 bundle 层 + 用户层」**；
- **行的书写顺序不含加载语义**（激活由图依赖/服务可用性驱动），分组只为读者。

**前端也是插件，且一区一包**：`dsh-client-ui-sidebar` / `-chat` / `-settings` / `-theme` / `-trajectory` … 声明方式在 `package.json`：

```json
"dsh": { "client": { "inject": ["…控制器/渲染器包…"], "platform": "web" } },
"exports": { ".": …, "./client": "./lib/client.js" },
"peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
```

另有 `dsh-client-modules`（前端模块装配）、`dsh-cordis-client-runner`（浏览器侧跑 cordis）、`dsh-api-*-controller` + `dsh-api-gateway`（网关）——**一条「浏览器也跑 cordis」的路，与我们 M1 的 `@cordisjs/client` 外壳同源**。

**命名即分层**：包名前缀直接暴露角色 —— `dsh-<域>-<角色>`，`-local` = 本机实现、`-policy` = 策略、`-client-ui-` = 前端区域。

### 1.3 cordis 官方（本仓 `node_modules/@cordisjs/`）

- 切分粒度：**一个能力一个包**（`plugin-server` / `plugin-timer` / `plugin-database` / `plugin-webui` 各自独立，**互不引用**）。
- 每个包用 `package.json` 的 `cordis` 字段自描述（`description.zh` / keywords），**所以 `plugin-loader-webui` 才能自动扫出插件清单** —— M1 实测列出 11 个插件靠的就是这个字段。
- 依赖注入靠 `inject`，插件注册的服务在停用时由框架**自动回滚**（`effect`）。
- `isolate: { server: debug }` 让**同名服务在不同 realm 各有一份实例** —— M1 的 5172 与 8080 隔离就是这么来的。这一点对我们很重要：**「同一能力多实例」是 cordis 原生支持的**，不必自己做注册表多例。

---

## 2. 提炼出的四条规律

| # | 规律 | 落地成什么 |
|---|---|---|
| 1 | **包名即分层** | 包名 = `space-<域>-<角色>`，角色后缀固定（`-local` / `-policy` / `-client-ui-`），看名字就知道依赖方向 |
| 2 | **组合靠 overlay，不靠 import** | bundle 层 + 用户层 patch；同一行最多两层；patch 替换整体 config，不合并 |
| 3 | **seam 拥有词汇** | 类型、branded id、错误分类法**只写在 seam**；实现与策略不得自造错误串，只能抛 seam 的错误码 |
| 4 | **UI 一区一包 + manifest 下发** | 后端只给 `Slot/Key/Title/Props`；前端按 key 找组件，未知 key 降级占位 |

---

## 3. teamspace-cordis 的模块划分（方案 A）

### 3.1 目录树（目标态）

```
teamspace-cordis/
├─ src/index.ts                    启动，零业务                        （现状保留）
├─ composed.cordis.yml             组合根 = bundle 层叠加的产物（启动时生成，不入库）
├─ config/app.yml                  框架自身参数（应用名、清单路径）       （现状）
├─ profiles/                       ← 每个「面」一份用户层 patch
│   ├─ debug/cordis.yml            调试控制台（= 现 M1 的 5172 那套）
│   └─ teamspace/cordis.yml        团队空间（5173/5174）
├─ plugins/                        叶子插件：无需换实现、无需被策略包裹
│   ├─ health/                     （现状保留）
│   └─ app/                        （现状保留）
├─ packages/
│   ├─ seam/                       能力缝：只有 Service 定义 + 词汇类型，零实现
│   ├─ impl/                       实现层
│   ├─ policy/                     策略层
│   ├─ client-ui/                  前端：一区一包
│   └─ bundle/                     组合层：自带 cordis.patch.yml
├─ gate/                           CI 门禁脚本（移自旧系统，含 secret_scan）
├─ .rules/  docs/  scripts/        铁律 / 文档 / 运行脚本            （现状）
└─ dev-cordis/                     本目录：规划与调研
```

**为什么 `plugins/` 与 `packages/` 并存**：`plugins/` 是「叶子」——不需要 seam，也不会被策略包裹，一个目录一个 `index.ts` 就完事（`health`、`app` 属此类）；`packages/` 是「有缝的」——需要被别人替换实现、或被策略包裹。判据见第 0 节。**不是两套标准**：两者都是 cordis 插件，只是包边界要不要划的问题。

### 3.2 seam 层（`packages/seam/`）

一个 seam = 一个 cordis `Service` + 一组词汇类型 + 一个错误分类法。**服务里管「集合」的地方用 Map + 注册事件**（cordis 的服务表是单例，多实现要靠服务内部集合，或靠 `isolate` 分 realm）。

| seam 包 | 服务名 | 承接旧系统的 | 词汇（只写在这里） |
|---|---|---|---|
| `space-session` | `ctx.session` | `services/store/member.go`、`domain/principal.go`、`domain/dri_rotation.go` | `Session` / `Member` / `Role`（含 `coordinator` 不参与调用链）/ 角色冲突错误 |
| `space-event` | `ctx.eventLog` | `domain/event.go` | 事件模型（append-only）、会话内序号、事件类型注册表。**不叫 `ctx.events`**：cordis 内核已占用该名（内核的 `events` 是事件总线，本缝是 append-only 事件存储），P0 实测撞名 TS2717 后改名 |
| `space-message` | `ctx.messages` | `elements/message/` | 入站消息管线（拦截/改写/落库的顺序约定） |
| `space-command` | `ctx.commands` | `elements/command/` | `Invocation` / `Reply` / `Ctx`；**Parse 与 Dispatch 是本 seam 仅有的两个机制函数** |
| `space-staging` | `ctx.staging` | 旧前端 `StagingPanel.vue` + `/add` `/cur` `/del` `/change` `/clear` `/commit` 指令族；旧 `store/doc.go` 已为它预留 `0006_staging_entries`（**旧库当时尚未建表**） | `Entry{ID,SessionID,AuthorID,Seq,Text,CreatedAt}`；**只有作者能改/撤自己的条目** |
| `space-orchestrator` | `ctx.orchestrator` | `domain/coordinator.go`、`domain/loop_detect.go` | 委托决策、授权名单、**暂停点（`await_human`）**、三级兜底结果形状 |
| `space-ui` | `ctx.ui` | `elements/ui/` | `Panel{Key,Slot,Title,Props}` + `ManifestItem`；槽位常量 `right`/`bottom`/`composer` |
| `space-history` | `ctx.history` | `elements/history/` | 事件视图过滤器 |
| `space-dialog` | `ctx.dialog` | `elements/dialog/` | 结构化对话流的只读扩展点 |
| `space-memory` | `ctx.memory` | `elements/memory/` | 私有记忆的服务接口 |
| `space-tool` | `ctx.tools` | `elements/tool/` + `internal/tools/` | 工具目录 + 注册表 |
| `space-bus` | `ctx.bus` | `services/sse/` | 推送信封（谁订阅、重放策略） |
| `space-workspace` | `ctx.workspace` | `domain/{gantt,story,kickoff,template,disposition,evaluation,summarizer}` | 工作台视图模型（**先合一个包，不预拆**）。**硬判据**：桶里成员一旦「需要换实现」必须立刻独立成 seam，不得赖在这里 —— 见第 7 节待定 4 |
| `space-agent`（**P6 草案，未开工**） | `ctx.agents` | 无旧对应（2026-09-29 新需求，见第 7 节新增小节） | **机器人注册表**：`AgentDescriptor{kind: meeting\|coding, 提示词引用, 能力清单}`、入驻/退驻/心跳、生命周期状态机（idle/working/paused/done）。**入驻 = 向本缝注册**；会议机器人与 Coding Agent 同一张表（成员即 `Member`）。「自己的天地」用 cordis isolate realm 承载（5172/5174 先例），「自己的生命」= 插件生命周期 + 每 agent runtime（timer/loop 先例） |
| `space-workdir`（**P6 草案，未开工**） | `ctx.workdir` | 承旧 `internal/sandbox` 的 `execdir` 语义 + 新需求 | **每 agent 文件工作区**：领取/创建/清理、路径隔离、与沙箱 policy 的边界。**刻意与 `space-workspace`（工作台视图模型）分开**，防杂物袋（命名见待定 8，推荐新缝） |

### 3.3 impl 层（`packages/impl/`）

| 包 | 实现 | 说明 |
|---|---|---|
| `space-store-sqlite` | `ctx.eventLog` / `ctx.session` / `ctx.staging` / `ctx.memory` 的 sqlite 后端 | 承接旧系统 10 张表 + `migrate` / `seed` / `reset`；**表结构改动必须有迁移 + 重置 + 种子** |
| `space-store-memory` | 同上，进程内 | 给测试用：**seam 有第二个实现，才证明缝是真的** |
| `space-bus-sse` | `ctx.bus` | 承旧 `services/sse` |
| `space-tool-fs` / `space-tool-bash` | `ctx.tools` 的具体工具 | 承旧 `internal/tools/catalog` + `internal/sandbox`（沙箱边界见 policy） |
| `space-platform` | trace / ring / streaming / runinfo | 承旧 `internal/platform`；**日志部分优先用 cordis 自带 `ctx.logger`，不重造** |

**迁移口径（承旧 `store/doc.go`，照抄）**：迁移链**按域分文件**，核心域用 `svc.` 前缀（`0001`–`0005` 依次是 `meta` / 身份 / 会话 / 事件 / 插件）；**插件域表随插件落地，文件名用插件名前缀**（如 `0006_staging_entries`）——「每插件一节」，装不装一个插件只看它的迁移 + 启用开关。**已提交的迁移不许再改**（会有库已经跑过它），要改就加新的。

### 3.4 policy 层（`packages/policy/`）

策略**不实现能力，只包裹能力**。

| 包 | 包住谁 | 内容（全是硬约束，来自既有系统） |
|---|---|---|
| `space-authz` | `ctx.orchestrator` + `ctx.commands` | 授权名单（`recorder` / `challenger` / `analyst` 三个目标 agent，**coordinator 不在名单**）；`@指令` 必须走 NLP 判定而**不是字符串识别**；人类消息不以 `/` 开头 → 只入暂存区、不触发 Plan；`先讨论` / `只商议` 的暂停语义；三级兜底（纯文本无委托 → 只回复 / 坏 JSON → 正则救回 / 明说「将转达 X」→ 补委托），每次兜底 `Warn` 并留原文 |
| `space-sandbox` | `ctx.tools` | 命令沙箱 `audit` / `confine` / `execdir`（承旧 `internal/sandbox`） |
| `space-gate` | 无（CI 期） | 门禁断言集合（见第 6 节），由 `npm run` 触发 |

### 3.5 client-ui 层（`packages/client-ui/`）——**前置门槛最高的一层**

**一区一包**，每包的注册方式沿用官方 webui 的机制（包内 `apply` 调 `ctx.webui.addEntry(...)`），`package.json` 的 `cordis` 字段写元数据以便被 loader-webui 扫出。

| 包 | 区域 | 承接旧前端 |
|---|---|---|
| `space-client-ui-layout` | 外壳 / 布局（**尽量零代码，直接复用 `@cordisjs/client`**） | `web/teamspace-vue/src/App.vue` |
| `space-client-ui-timeline` | 时间线（人类 + Agent 发言、coordinator 消息正常显示、`a_coordinator` 出现在成员表） | `views/` |
| `space-client-ui-composer` | 输入区 + 暂存区面板（槽位 `composer`） | `panels/registry.ts` 的 `staging` / `queue` |
| `space-client-ui-right-panel` | 右栏：轮次状态（已暂停）、暂停原因（等待人类下一步指示）、coordinator 调用次数 | 旧右栏 |
| `space-client-ui-members` | 成员 / `@` 提及清单（3 个目标 agent + 人类，**不含 coordinator**） | `components/` |
| `space-client-ui-console` | 管理台面（插件启停、JSON 配置编辑、运行状态） | `web/console/` |

> ✅ **这一层与铁律 1 的相交已解决（2026-09-27）**：选型扩展已写进
> [`../.rules/IRON-RULES.md`](../.rules/IRON-RULES.md) →「选型扩展：我们自己写页面时」。
> 结论：**不引入第二套组件库** —— 组件用外壳已全局注册的 `element-plus` + `k-*` 组件集，
> 令牌用外壳 `app/styles/index.scss` 的语义变量白名单，本仓库仍然**零样式文件**。
> 门禁 `npm run lint:styles` 的扫描范围已加上 `packages/`（实测仍全绿）。

#### 构建口径（定于 2026-09-27，解决待定 2 → 选 A2）

官方包的长相是**三件套**，我们照抄（样板：`node_modules/@cordisjs/plugin-loader-webui`）：

```
space-client-ui-timeline/
├─ client/index.ts      页面源码（只被 Vite 编译，不进 npm 包）
├─ lib/index.js         服务端：apply 里 ctx.webui.addEntry({ baseUrl, source, manifest }, data)
├─ dist/                ← vite build --manifest 的产物：index-<hash>.js / index-<hash>.css / manifest.json
└─ package.json         "build": "vite build --manifest"
```

- 注册调用的官方原文（`plugin-loader-webui/lib/browser.js:131`）：

  ```js
  this.ctx.webui.addEntry({
    baseUrl: import.meta.url,
    source: "../client/index.ts",      // 开发态用 —— 这条路我们不启用
    manifest: "../dist/manifest.json", // 生产态用 —— 我们只走这条
  }, data)
  ```

  `manifest.json` 就是**普通 Vite manifest**（`client/index.ts` → `index-<hash>.js`，`style.css` → `index-<hash>.css`）。
- 运行时保持 `devMode: false`，只读 `dist/manifest.json`。
- **`dist/` 不入库**（`.gitignore` 第 14 行本来就在忽略 `dist/`），**构建进启动脚本**：各包 `build` 脚本 + 根 `package.json` 串一个总入口，由 `scripts/run.sh` / `scripts/dev.sh` 在启动前调用。
- **代价（明确接受）**：不吃 HMR。改一行页面代码要重跑 build 再刷新浏览器。
- **不修 `devMode` 的原因**：`devMode: true` 下 webui 会去编译 `@cordisjs/client` 的源码，在 `theme/menu/menu.vue` 处报
  `No fs option provided to compileScript in non-Node environment`，页面全白（记在 `docs/ROADMAP.md` 的 M1 小节）。
  要修得改官方包的 `createVite` 行为 —— 在没有真实痛点之前不动它。

### 3.6 bundle 层与 profile（组合）

```
packages/bundle/
├─ space-base/                    第一个 patch 层：核心行（session / event / store / command / staging /
│  ├─ cordis.patch.yml            orchestrator / authz + 官方 server/timer/database/logger）
│  └─ package.json                ← 声明 "cordis": { "bundle": { "patch": "./cordis.patch.yml" } }
├─ space-surface-teamspace/       团队空间面：ui seam + client-ui 包族 + 5173/5174
└─ space-surface-debug/           调试控制台面：官方 loader/logger/database-webui + 5172（= 现 M1 那套）
```

`profiles/<面>/cordis.yml` 是**空根 + 用户层**：所有 `<面>/cordis.patch.yml` 只做「按 id 覆盖 config / 停用 / 追加」三件事，**不重复 bundle 里已有的行**。

### 3.7 依赖方向——**建议新增铁律 2**

| 层 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `seam` | `cordis`、同层 `seam`、`schemastery`（配置校验） | `impl` / `policy` / `bundle` / `client-ui` |
| `impl` | `cordis`、**任意 `seam`**、第三方驱动 | **任何其它 `impl`**、`policy`、`bundle` |
| `policy` | `cordis`、任意 `seam` | `impl` 的具体实现类、`bundle` |
| `client-ui` | `cordis`、`@cordisjs/client`、`@cordisjs/components`、`seam` 的**类型**、`client-ui` 的 **shared 包**（2026-09-28 P4 起：页面共享件是选型表明定的抽组件去处；页面之间互引仍禁止） | `impl` / `policy` / `bundle` |
| `bundle` | 任意（它只写清单，不写代码） | —— 反向：**任何包都不得依赖 `bundle`** |
| `plugins/` 叶子 | `cordis`、任意 `seam`、任意 `policy`（2026-09-28 P3 起：叶子是组合点，要把 policy 纯函数接到能力上，如 orchestrator → space-authz；纯函数无状态，不构成第二实现） | `impl` 的具体实现类 |

> 这张表若只写在文档里就等于没写。**必须有脚本扫每个 `package.json` 的 `dependencies` 比对矩阵，违反判红，并实测改坏一次会红。** 见第 6 节断言 ①②。

---

## 4. 迁移映射（旧 → 新，对账用）

| 旧 | 新 | 备注 |
|---|---|---|
| `internal/kernel/` | **不要了** | cordis 内核（`Context` / `Service` / `inject` / `effect` 回滚）即替代；`Registry[T]` 的「多实现集合」改由 seam 服务内部 Map 承载 |
| `internal/elements/command/` | `seam/space-command` | Parse/Dispatch 双机制函数原样继承 |
| `internal/elements/ui/` | `seam/space-ui` + `client-ui/*` | manifest 下发 + 未知 key 降级占位原样继承 |
| `internal/elements/{message,history,dialog,memory,tool}/` | 对应 seam | —— |
| `internal/elements/webroute/` | **不要了** | `ctx.server` 路由即替代（M1 已在用） |
| `internal/domain/coordinator.go` | `seam/space-orchestrator` + `policy/space-authz` | **职责分家**：seam 定义「委托/暂停」的词汇与状态机；policy 管「谁被授权、NLP 怎么判、兜底怎么写」 |
| `internal/domain/event.go` | `seam/space-event` | append-only 语义保留 |
| `internal/domain/{principal,dri_rotation,loop_detect}` | 分别并入 `space-session` / `space-orchestrator` | 它们不是独立能力，是这两个 seam 的内部规则 |
| `internal/domain/{gantt,story,kickoff,template,disposition,evaluation,summarizer}` | `seam/space-workspace`（暂合） | 出现第二个实现者再拆包 |
| `internal/services/store/` | `impl/space-store-sqlite` | 10 张表 + `migrate`/`seed`/`reset`；`staging_entries` 的新表也要按同口径加迁移 |
| `internal/services/sse/` | `seam/space-bus` + `impl/space-bus-sse` | 先定信封，再做实现 |
| `internal/platform/`（日志部分） | **不要了** | 用 `ctx.logger`（M1 已验证日志页能出真实数据） |
| `internal/platform/`（trace/ring/streaming） | `impl/space-platform` | —— |
| `internal/sandbox/` | `policy/space-sandbox` | 沙箱是策略，不是能力 |
| `internal/tools/` | 并入 `seam/space-tool` + `impl/space-tool-*` | —— |
| `gate/` | `gate/`（留根目录） | CI 门禁不是运行时模块，不进 `packages/` |
| `web/console/` | `client-ui/space-client-ui-console` | 管理台面 |
| `web/teamspace-vue/` | `client-ui/space-client-ui-{layout,timeline,composer,right-panel,members}` | 按区域拆 |
| `web/shared/` | `client-ui/space-client-ui-shared`（仅类型与 API 客户端） | **设计令牌不进这里**——令牌由外壳注入（铁律 1） |
| `.rules/` | `.rules/`（留根目录） | 铁律唯一出处 |

---

## 5. 落地顺序

每一阶段**自带验收**，不通过不进下一阶段。

| 阶段 | 内容 | 验收（可观测） |
|---|---|---|
| **P0 立骨架** ✅ **已完成（2026-09-27）** | `npm workspaces` 接通；`packages/` 五层目录立起；**每个 `package.json` 写 `private: true` + `workspace:*`**；依赖方向门禁脚本（断言 ① ② ⑦）+ 实测改坏会红；**每个 seam 包只放一个空的 `Service` 声明**（零业务）；**建 `scripts/check-console.sh`（断言 ⑩，铁律 2）**；**5172 控制台不许在立骨架过程中被弄丢** | ✅ 全部达成：`npm run typecheck` 退出码 0；13 个 seam 包就位（`packages/seam/space-*`）；`impl`/`policy`/`client-ui`/`bundle` 四层占位；**实测三种改坏各自判红**（impl→impl / `private:false` / seam 里 `import 'node:fs'`，详见 `scripts/lint-deps.sh` 文末自检记录）；`check-console.sh` 三页全 200，**故意改错端口 → 退出码 1**。**执行中实测出一处规范错**：`ctx.events` 与 cordis 内核撞名 → 改名 `ctx.eventLog`（见第 3.2 节） |
| **P1 首个真能力** | `seam/space-session` + `seam/space-event` + `impl/space-store-sqlite`（**只建 `sessions` / `session_members` / `events` 三张真表** —— 待定 6）+ `migrate`/`seed`/`reset` + **断言 ⑧**（DDL 只在迁移里） | 调试控制台 5172 的**数据库页从 0 张表变成 3 张真表**；迁移 `up→down→up` 幂等；故意在插件里写 `CREATE TABLE` → 退出码 1 |
| **P2 交互元素** ✅ **已完成（2026-09-28）** | `seam/space-command` + `seam/space-staging` + 指令族（`/add` `/cur` `/del` `/change` `/clear` `/commit`） | 非 `/` 开头消息只入暂存区、**不触发** coordinator；`/commit` 恰好触发**一次** Plan；未注册指令返回可用清单。**✅ 全部达成（2026-09-28）**：`verify:staging` 44 断言全过且进 gate（第七门禁）；**红测改坏必红**（删 emit 信号 → 3 红退出码 1，还原复绿）；迁移 down→up→再 up 幂等（v4→v0→v4→无变更）+ seed 重播幂等；`npm run gate` 七门禁全绿；5172 数据库页 4→**5** 张表。实测教训：cordis 服务代理重绑 this，`#` 私有字段必炸 → Plan 信号改走内核事件总线（见修订记录 2026-09-28） |
| **P3 协作大脑** ✅ **已完成（2026-09-28）** | `seam/space-orchestrator` + `policy/space-authz`（业务硬约束按**可断言子集**落成断言 —— 待定 5，清单在该行） | 授权名单外目标 → 拒绝；人类 `@` 指令走 NLP 判定；三级兜底各自有断言；收到目标 agent 反馈后**必须**输出暂停并等人类。**✅ 全部达成（2026-09-28）**：`verify:orchestrator` 52 断言全过且进 gate（第八门禁，用户拍板）；**红测三组各自会红**（摘名单校验 → 6 红退出码 1；摘「反馈后必须暂停」→ A5g/A5j 红；停用 orchestrator 插件 → Part B 接线 3 红，各自还原复绿）；`npm run gate` 八门禁全绿（exit=0，verify-staging 44/0 依旧） |
| **P4 前端** ✅ **已完成（2026-09-28）** | `seam/space-ui` + `client-ui/space-client-ui-*` | 前置「待定 1 / 待定 2」**均已解决**（见第 3.5 节与第 7 节）；`npm run lint:styles` 扫到 `packages/client-ui/` 且全绿；**每个包 `vite build --manifest` 能出 `dist/`，且 `git status` 里看不到 `dist/`（A2 生效）**。P4 开工时须把铁律新增的 3 条判红条件变成**会红的**断言（见第 6 节 ④）。**✅ 全部达成（2026-09-28）**：① 铁律新增 3 条判红条件落成 lint:styles 断言 ⑤⑥⑦ 且**实测改坏会红**（--el-/--k-/--bg2 探针、--brand-x 定义探针、import 'element-plus' 探针各自判红）；② 五包就位（shared + timeline/composer/right-panel/members，用户拍板最小集），`build:web` 出 dist/、`check:web` 断言外壳 + 四页 chunk 全 200 + dist 不入库（删 dist → 红）；③ 5174 团队空间面（TEAMSPACE_PORT）与 5172 并存互不污染；④ `npm run gate` 九门禁全绿 |
| **P5 组合收敛** ✅ **已完成（2026-09-28）** | `bundle/space-base` + 两个 surface + `profiles/{debug,teamspace}`；现有 `cordis.yml` 退化为叠加结果（产物 `composed.cordis.yml` 落项目根，gitignore 不入库，启动时由 `src/compose.ts` 生成） | **✅ 全部达成（2026-09-28）**：断言 ③ 落成 `scripts/lint-patch.sh`（第十门禁，列 lint:deps 后），**红测改坏必红**（surface-teamspace 塞 `id: server` → 「出现在两个 bundle 层」判红，还原复绿）；**用户层停用行实测**：`debug-database-webui: disabled: true` → 组合产物「停用 1」→ 5172 数据库页 chunk 404、check:console 判红（退出码 1）→ 还原复绿（chunk 200 / 退出码 0），一举实证「删用户层行能力消失」+ 断言 ⑩ 活着；组合产物与旧 cordis.yml **按 id 逐项等价**（21 = 21 行，含 `!!js` 原文逐字一致）后删旧清单；`npm run gate` 十门禁全绿。**拓扑拍板（用户 2026-09-28）**：方案 A 单进程多面（compose 合成「base + 两 surface + 用户层」单清单单进程）；**5173 保持未启用**，本行验收口径按「5172 / 5174 两实 + 5173 预留」执行 |
| **P6 多智能体入驻（Coding Agent 可插拔）** ✅ **P6-1~P6-4 完成（2026-09-29）：两缝 + 注册表 + stub 入驻 + 断言 ⑪；仅 P6-5 提示词接入等原文** | `seam/space-agent` + `seam/space-workdir`（命名已决 2026-09-29）+ `impl/space-agent-*`（生命周期 runtime）+ 工具/沙箱缝补真 + 4 个角色提示词接入（**等用户给原文**） | **两条不变式**：①开会功能不回退（gate 十一门禁全绿不动）；②**入驻 = 纯新增**——新增一个 Coding Agent 只允许「新增包 + patch 层加一行」，任何既有文件零改动（断言 ⑪ 实测改坏会红）。步骤：缝声明（零实现）→ 最小入驻示例（stub 生命周期：报到/领任务/回执，不接真模型也能证明入驻机制）→ 断言 + 红测 → 提示词接入。需求原话见第 7 节 2026-09-29 小节 |

---

## 6. 门禁断言（每条都必须实测「改坏会红」）

| # | 断言 | 判红条件 | 落点 |
|---|---|---|---|
| ① | **依赖方向矩阵** | 任意 `package.json` 的 `dependencies` 违反第 3.7 节允许表 | `scripts/lint-deps.sh` |
| ② | **seam 无实现** | `packages/seam/**` 下出现 IO 依赖（`node:fs` / `node:sqlite` / 网络库）或 `dependencies` 越出白名单 | 同 ① |
| ③ | **patch 层数** | 任意 `id` 出现在超过「一个 bundle 层 + 用户层」 | `scripts/lint-patch.sh` |
| ④ | **样式来源** | 分两批：**已实现**——内联样式 / 自写样式块 / 硬编码颜色（铁律 1），扫描范围**已扩到 `packages/`**（实测通过）；**待实现**——铁律 2026-09-27 新增的 3 条（用错令牌层 `--k-*`/`--bg0-3`/`--fg0-3`/`--el-*`、第二个令牌来源、重复 `import 'element-plus'`）。**必须在 P4 开工时补齐，且实测改坏会红**——`packages/` 现在还不存在，此时写就是空断言，铁律自己不接受 | `npm run lint:styles`（已建） |
| ⑤ | **端口唯一出处** | 代码 / 清单里出现第二个写死的端口数字 | 已由 `scripts/env.sh` 拒绝启动覆盖 |
| ⑥ | **注册重名 panic** | 命令 / 元素 / 工具重名 —— 沿用旧系统口径（重名是编程错误，测试期就炸） | 各 seam 单测 |
| ⑦ | **包一律私有** | `packages/**/package.json` 里 `private` 不为 `true`，或出现 `publishConfig`（对应待定 3 的落地） | ✅ **已建（P0）**：`scripts/lint-deps.sh`（`npm run lint:deps`）同批实现，含「内部引用必须写 `workspace:*`」。实测改坏会红 |
| ⑧ | **DDL 只在迁移里** | `packages/**` + `plugins/**` 下（**排除 `**/migrations/**`**）出现 `CREATE TABLE` / `DROP TABLE` / `ALTER TABLE`（对应待定 7 的落地） | ✅ **P1 已建并实测改坏会红**（`scripts/lint-migrations.sh`；探针 绿→红→绿；scripts/ 豁免并记账：迁移运行器自身要建 schema_version） |
| ⑨ | **动作留痕**（铁律 2） | 跑过 `npm run gate` / `typecheck` / `migrate` / `seed` 之后，库里**必须多出可查记录**；「跑了但不留痕」判红 | ✅ **P1 已建并验证**（留痕表 `action_log` 由迁移 0003 建；`scripts/store.ts` 强制留痕 migrate/seed/reset，`scripts/record-action.mjs` 留痕 gate；核查已跑通：action_log 留痕齐全） |
| ⑩ | **控制台可达**（铁律 2） | 启动后 5172 的插件 / 日志 / 数据库**三页 HTTP 200**；任一非 200 判红 | ✅ **已建（P0）**：`scripts/check-console.sh`（`npm run check:console`）。不只验 `GET /`（SPA 外壳恒 200，那是弱断言），而是读三个页面包各自的 `dist/manifest.json`，按 webui 的模块 URL 规则 `{uiPath}/-/v1/modules/{manifest.path}/{chunk.file}` 逐个取 chunk —— 这才证明三页**真被加载**。2026-09-27 实测：7 个 URL 全 200；把 `DEBUG_PORT` 改错 → 退出码 1 |
| ⑪ | **Agent 可插拔入驻**（**P6 已建，2026-09-29**：`scripts/verify-agents.ts` 第十一门禁） | 新增/停用一个机器人时，除「**新增包 + patch 层行**」外不得改动任何既有文件（落点：**白名单路径扫描**——agent 特判只准住在 agent 包 + Part B 断言非 / 消息仍走暂存；开会回归由 gate 链 verify:staging/orchestrator 顺带保证） | **已实测**：①orchestrator 塞 `agent.coder` 特判 → 判红 exit 1 → 还原复绿；②改坏 STATUS_TRANSITIONS（删 done→idle）→ invalid_transition 红 → 还原复绿（27 断言 27 过，gate 十一门禁全绿） |

---

## 7. 决策记录（原「待定项」）与风险

> **原 7 项全部已定**（2026-09-29 起新增 P6 待定 8~10，见下方小节）。下表保留「为什么这么定」的理由 —— 决策本身会随实践修订，
> 但修订时必须回到这里改，不许只在代码里默默改掉。

| # | 事项 | 现状 | 为什么是门槛 |
|---|---|---|---|
| **1** | ~~铁律 1 与 `client-ui` 层正面冲突~~ | ✅ **已解决（2026-09-27）** | 选型扩展已定稿并写进选型表：组件 = 外壳全局注册的 `element-plus` + `k-*` 组件集；令牌 = 外壳 `app/styles/index.scss` 语义变量白名单；**不引入第二套组件库**。新增 3 条判红条件（用错令牌层 / 第二个令牌来源 / 重复 import element-plus）。**P4 的前置门槛由此满足** |
| **2** | ~~前端构建面~~ | ✅ **已解决（2026-09-27，选 A2）** | 见第 3.5 节「构建口径」：各包自己 `vite build --manifest` 产出 `dist/`，运行时 `devMode: false` 只读产物；**`dist/` 不入库**（`.gitignore` 第 14 行本来就在忽略），构建进启动脚本。**不吃 HMR** —— 改一行要重跑 build |
| **3** | ~~seam 包是否发布~~ | ✅ **已解决（2026-09-27）：不发布** | 发布 npm 的前提是「仓库外有消费者」。我们是单仓单部署，**没有外部消费者** —— 发布只会换来版本号纪律、publish 凭据、以及「改了 seam 要记得 bump + 通知消费者」的长期成本。方案 A 已经把**包边界**立起来了，而**边界才是重构成本**；发布只是 `private: false` + `publishConfig`，**将来要发布不需要重构**。落地：`packages/**/package.json` 一律 `"private": true`，互引用 `workspace:*`；断言见第 6 节 ⑦ |
| **4** | ~~`space-workspace` 拆不拆~~ | ✅ **已解决（2026-09-27）：暂合成一个包，不预拆**，**另附一条硬判据** | 「出现第二个实现者 / 第二个消费者再拆」与 dsh 的做法一致。**补一条防杂物袋的判据**：桶里任何成员一旦出现**「需要换实现」**（如 `summarizer` 换模型、`evaluation` 换评分器），该成员**必须立刻独立成 seam**，不得赖在 `space-workspace` 里。理由：混着放，`ctx.workspace` 就会变成什么都能挂的口袋 —— 那正是旧 `internal/domain/` 的病。**这条是判据、不是断言**：「需要换实现」是判断题，不硬造断言（口径同待定 5） |
| **5** | ~~授权名单等业务硬约束的落点~~ | ✅ **已解决（2026-09-27）：落到 `policy/space-authz` 的断言**，但**只做可断言的子集** | **口径**：凡能写成「给定输入 → 期望允许 / 期望拒绝」的，**必须有会红的断言**；纯表述质量（如「回复要自然」）**不硬造断言**。可断言的子集（来自 `project_memory`）：授权名单只含需求分析师 / 挑战者 / 会议记录官且**排除 coordinator**；名单外目标必拒；一轮内同一目标只能调一次；未经人类授权不得调用；收到目标反馈后必须暂停；`@` 提及列表不含 coordinator；coordinator 显示为 `a_coordinator`；只有发送者可撤回 / 编辑自己的待发消息；「先讨论」「只商议」→ 暂停且 `delegate: null`；三级兜底三种入参三种期望；负向语气 / 多目标 / 空输出 → 不委托、不报错、不暂停 |
| **6** | ~~旧系统那 10 张表是否原样搬~~ | ✅ **已解决（2026-09-27）：P1 只搬 3 张** | `sessions` / `session_members` / `events`。**不做「先全搬再重构」** —— 全搬等于把旧模型照抄一遍（含我们打算不要的角色 / 权限字段），之后每改一次就欠一笔迁移债。其余 7 张按需：`users` / `auth_sessions` / `principals` / `team_accounts` 属鉴权，M1 已明确初期不做 → **后置**；`plugins` / `settings` / `meta` 是框架自身的，由 cordis 生态（loader / database 插件）接管。迁移文件命名与「已提交迁移不许改」承旧 `store/doc.go` 口径 |
| **7** | ~~「每插件一节」迁移 与 cordis 运行时启停的耦合~~ | ✅ **已解决（2026-09-27）：留表不回滚，且 DDL 与插件生命周期彻底解耦** | 两条。① **停用插件时表与数据都留着**：cordis 的 `effect` 回滚的是**注册**（服务 / 事件 / 路由），**不是数据** —— 顺应框架语义；且数据回滚在多人协作系统里是危险动作，配置一改就静默删表，几乎无法排查。② **DDL 不许写在插件里**：不在 `apply` 生命周期跑建表，迁移是独立的 `migrate` 命令；schema 版本由**迁移链**自己管，与插件启停无关（插件停用再启用**不重跑迁移**）。断言见第 6 节 ⑧ |
| **8** | 多智能体入驻（P6 方向） | ✅ **方向已拍板（2026-09-29）：先落规划，未开工** | 用户原话：「这个插件系统必须承受得住新机器人的加入，除了支持基本的会议中的机器人，还要支持新的机器人比如开发项目者、测试者等，他们有自己的生命，有自己的工作区，有自己的天地，可以理解为一个 Coding Agent。因此这个插件系统必须经得起**通过添加插件的方式添加入驻**这种 Coding Agent，同时又不失之前定义好的开会功能，支持机器人的特殊功能，比如开发项目之类的。」落表：§3.2 两缝草案 + §5 P6 行 + §6 断言 ⑪ 草案；细节待定见下节 |

### P6 待定项（2026-09-29 新增；8/9 已决，剩 10 等提示词原文）

| # | 待定 | 选项与推荐 |
|---|---|---|
| 8 | 文件工作区缝语义 | ✅ **已决（2026-09-29，用户拍板）：新缝 `space-workdir`**（`space-workspace` 防杂物袋判据不受污染） |
| 9 | Coding Agent 任务回路 | ✅ **已决（2026-09-29，用户拍板）：先做最小（人类 `@` 直派，stub 回执）**；orchestrator 委托（复用授权名单）随后再加 |
| 10 | 4 个角色提示词的接入形态 | 提示词 = agent 配置的一部分（入驻/建会话时选用）；**等用户提供原文**（角色1 会议记录 / 角色2 编码 / 角色3 测试 / 角色4 代码审查） |

**铁律 4 已写入 `IRON-RULES.md`（2026-09-29，用户拍板）**：「机器人可插拔入驻 + 开会功能不回退」两条不变式。⚠ 编号注记：`铁律 3`（组合叠加）正文缺位——只在代码注释与交接档案被引用（断言 ③ 是其可执行形态），IRON-RULES 现为 1/2/4 跳号，见已知缺陷 D2。

### 已知缺陷（发现即记账，不许只在对话里说过就完）

| # | 缺陷 | 发现于 | 影响 | 状态 |
|---|---|---|---|---|
| **D1** | `scripts/stop.sh` 的端口清单**漏 `DEBUG_PORT`**（第 22 行只遍历 `APP_PORT` / `CONSOLE_PORT` / `TEAMSPACE_PORT`），而它自己的注释写着「停掉 `.env` 里那几个端口上的进程」 | 2026-09-27 停 8080/5172 时 | 今天因 8080 与 5172 **恰好是同一进程**才停干净。一旦两者不同进程（只跑 debug profile，或 5172 拆成独立实例），`npm run stop` 会**留下 5172**，下次启动直接撞端口；`--check` 也照不到 5172。违反「端口只在 `.env` 定义一次」的口径 | ✅ **已修（2026-09-27，P0 顺手）**：`DEBUG_PORT` 已进遍历清单，两处输出口径同步。⚠️ **断言 ⑤ 的加强部分仍未做** —— 现在没有脚本扫「`scripts/*.sh` 里的端口枚举是否等于 `.env` 全量端口」，这类漏项只能靠人眼。留待后续（不硬造空断言） |
| **D2** | **`铁律 3`（组合叠加）无权威正文**：代码注释引用「MODULE-PLAN 铁律 3 / 3.6 节」（`src/compose.ts` 等 6 处）、交接档案 06 称其在 IRON-RULES.md，但两处正文都没有独立成条；IRON-RULES 现为 1/2/4 跳号。断言 ③（lint:patch）是它的可执行形态 | 2026-09-29 写铁律 4 时发现 | IRON-RULES「唯一出处」原则出现缺口；后来者按注释找「铁律 3」会扑空 | ⬜ **待用户拍板**：补正文进 IRON-RULES（推荐）或全局重排编号 |

---

## 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-27 | 建档。调研三个参照系（旧 `teamspace/`、deepseek-harness 240 个包、cordis 官方），定方案 A（monorepo 多包），给出五层骨架 + 依赖方向表 + 迁移映射 + P0~P5 落地顺序 + 6 条门禁断言 |
| 2026-09-27 | 补：迁移口径承旧 `store/doc.go`（按域分文件、插件域用插件名前缀、已提交迁移不许改）；`space-staging` 更正为「旧库尚未建表」；新增待定 7（迁移与运行时启停的耦合） |
| 2026-09-27 | **待定 1 解决**：`client-ui` 层选型定稿，写进 `.rules/IRON-RULES.md`「选型扩展」；门禁扫描范围加 `packages/`（实测通过）；新增 3 条判红条件留待 P4 变成断言 |
| 2026-09-27 | **待定 2 解决**：前端构建面选 **A2** —— 各包 `vite build --manifest` 出 `dist/`，`devMode: false` 只读产物，**`dist/` 不入库、构建进启动脚本**；明确接受无 HMR。新增第 3.5 节「构建口径」（含官方样板三件套与 `addEntry` 原文） |
| 2026-09-27 | **待定 3~7 全部拍板**，第 7 节改名为「决策记录」、当前无待定项：③seam **不发布**（`private: true`）；④`space-workspace` **不预拆** + 补「换实现必须独立」硬判据；⑤业务硬约束**只对可断言的子集**造断言，落 `policy/space-authz`；⑥P1 只搬 `sessions`/`session_members`/`events` 三张；⑦**留表不回滚** + DDL 与插件生命周期解耦。新增门禁 ⑦（包一律私有）、⑧（DDL 只在迁移里），落点与「何时建」都写明了 |
| 2026-09-27 | **建档铁律 2（开发过程必须让人类看得见）后的对齐**：第 6 节新增断言 ⑨（动作留痕，待 P1）、⑩（控制台三页可达，P0 建）；P0 内容与验收补上「建 `scripts/check-console.sh`」「5172 不许丢」；新增「已知缺陷」小节，首条 **D1 = `stop.sh` 漏 `DEBUG_PORT`** | 用户新增铁律 2 —— 观测点必须进设施与门禁，不能只靠自觉；D1 是停服务时实测发现的，按「发现即记账」落档 |
| 2026-09-27 | **P1 完成（首个真能力）**：①`seam/space-session` / `seam/space-event` 词汇补真（角色六值与库 CHECK 逐字一致、错误分类法、`validateEvent` 纯函数承旧 `Event.Validate`）；②`impl/space-store-sqlite` 落地（方案 A 混合：迁移链独立命令 `npm run migrate`/`migrate:down`/`seed`/`reset` 是 DDL 权威 + 插件注册同名 model 供 5172 数据库页展示 + `schema_version` 校验不一致拒绝启动 + 类型逐列对齐防驱动 prepare 重建）；③迁移 0001~0003（sessions / session_members / events + FTS5 trigram + 单 DRI 部分唯一索引；`principals` FK 剥离为刻意差异）+ 留痕表 `action_log`（0003）；④**验收全过**：up→down→up 幂等（v0→v3→v0→v3）、seed 两遍 9 行→0 行、重启后 CHECK/触发器/部分索引全在、5172 数据库页 0→**4** 张表（3 业务 + 1 留痕）、断言⑧⑨建立且红测通过、`npm run gate` 六门禁全绿 | 实测修正三处：**npm workspaces 不支持 `workspace:*` 协议**（EUNSUPPORTEDPROTOCOL，P0 断言⑦约定从未被真实跨包依赖检验过）→ 内部包依赖改 `"*"` 并同步 lint-deps 断言⑦；lint-migrations 扫描范围定为 packages+plugins（scripts/ 豁免并记账）；验收表写「3 张真表」实际为 3 业务 + 1 留痕 |
| 2026-09-27 | **P0 完成 + 一处规范错落地**：①`packages/seam/` 13 个 seam 包装上（零业务 Service 声明）、`impl`/`policy`/`client-ui`/`bundle` 四层占位、根 `package.json` 接通 `workspaces: ["packages/*/*"]`、`tsconfig.json` include 加 `packages`；②**服务名改了** —— `space-event` 的 `ctx.events` 与 cordis 内核内置 `events`（事件总线）撞名，`npm run typecheck` 报 TS2717，**改名 `ctx.eventLog`**（内核已占用 `events`/`logger`/`reflect`/`registry`，其余 12 个名字不撞）；③建 `scripts/lint-deps.sh`（断言 ①②⑦）与 `scripts/check-console.sh`（断言 ⑩），两者都**实测改坏会红**并把自检记录写在脚本尾部；④D1 修掉 | 用户指令「按方案 2 执行，直接开 P0 并启动服务验证」；撞名一事按用户拍板改成 `ctx.eventLog`（选项含 `ctx.eventStore`） |
| 2026-09-28 | **P4 完成（前端，最小可用集）**：①`seam/space-ui` 词汇补真（`Panel{key,slot,title,order}`、槽位常量 right/bottom/composer、`duplicate_panel` 注册即炸）+ `plugins/ui-registry` 唯一提供者；②五包（用户拍板最小集，console 后置）：`space-client-ui-shared`（labels + EventItem）+ timeline/composer/right-panel/members，官方三件套（client 源码 + dist/manifest.json + src/index.ts 调 `ctx.webui.addEntry`），数据经 entry data（RPC）直取服务不开 HTTP 口；③`plugins/space-api` 三个只读口（GET /api/sessions、/:id/events、/:id/members）+ GET /api/panels（用户拍板补齐）；④staging-commands 抽出 `handleInbound` 导出 —— composer 与 POST /messages 走**同一条语义路径**；⑤5174 团队空间面挂载（TEAMSPACE_PORT，与 5172 同款 isolate 拓扑）；⑥`build:web` 进启动脚本（A2）+ `check:web` 进 gate + `check:web` 红测（删 dist 红）；⑦`npm run gate` 九门禁全绿；⑧3.7 表 client-ui 行扩到 shared 包 | 核心教训三条：**isolate 键同时管「提供」与「消费」**——第二个 webui/timer 只标 server 不标 timer/webui，提供的服务撞 root 键（`service "webui" has been registered`）；**@cordisjs/client 的 types 直指 TS 源码**——tsc 顺类型链拖进外壳全部浏览器源，用最小类型桩（types/cordis-client.stub.d.ts）+ tsconfig paths 截断；**Vite 7 manifest 默认落 dist/.vite/**——CLI `--manifest manifest.json` 指回 dist/manifest.json。grep 模式以 -- 开头必须加 -- 分隔符（旧坑复发一次）。三项用户拍板：最小五包、挂 5174 新面、补三个只读 API |
| 2026-09-28 | **P4 验收返工（页面全白 → 修复）**：用户实测 5174「什么也看不到」，两层根因逐层挖出并修复：①**页面出现在外壳菜单/路由靠 client 代码自注册** —— webui entry 的 `routes` 选项只影响服务端 SPA 404/加载态判定，activity 必须由页面插件自己调 `ctx.client.router.page({path,name,icon,component})`（logger-webui dist 原文即如此）；我们的 entry 只导出组件 → 无路由 → 外壳空白。修复：四个 client 入口改为导出插件函数，内部注册 page（timeline 兼占 `/` 首页 + `/timeline`）。②**Vite 对自定义（非 HTML）input 默认摇掉入口导出** —— 无 `preserveEntrySignatures: 'strict'` 时连 `export default` 都不进产物，chunk 为空壳（外壳拿到 undefined，这就是官方 dist 都带 `export{...as default}`而我们没有的原因）。修复：四个 vite.config.mts 加该行。验证：served chunk 含 `export{… as default}`；ws 探针确认 5174 下发四 entry；`npm run gate` 九门禁全绿 | 教训：**chunk 200 ≠ 页面能用**——check:web 的「模块 URL 全 200」只证明加载，不证明注册与渲染；无浏览器环境时用 ws 探针（ws://host/api → entry:init 报文）+ 抓 served chunk 看 export 语句做机器侧证据，最终以用户亲眼看为准（铁律 2） |

| 2026-09-28 | **P4 二次返工（散页 → 整页，用户拍板）**：用户反馈四页「太零散」且「时间线（首页）」点不开（同组件重复注册两个 activity 的路径别名有缺陷）。重构：**四个区域页合并为一个 `space-client-ui-teamspace` 整页**（`/`，菜单名「团队空间」）—— 中间时间线、右列轮次状态 + 成员、下方输入区，component 内组合（el-row/el-col 分栏 + k-card 分卡），RPC 数据聚合进单一 entry（sessions/events/members/staging/turn/send）；四个 Panel 描述符照旧登记 ctx.ui（P5 组合面的台账不变）；shared 保留。第 3.5 节的分区域包表留给 P5 surface 阶段再评估 —— 现在的判据是「用户看得到的是一页，不是四个页面」 | 页面只做组合（铁律 1 落地动作 ①）的正确粒度是「页内区域」，不是「菜单页」；散页是拿 webui page 当 region 用导致的形状错位 |

| 2026-09-28 | **P4 三轮返工（可用性，用户实测反馈）**：①布局——时间线把页面撑长、输入区不固定 → 时间线/右列各自放进 `el-scrollbar`（height = calc(100vh - 320px) 组件 prop，非内联样式）内部滚动，页面总高约一屏，输入区固定底部；时间线自动滚到最新。②`@` 提及全链路——**迁移 0005_staging_mentions**（staging_entries 加 mentions TEXT DEFAULT '[]'，down DROP COLUMN）、Entry 增 mentions、append 带提及、**commit 取全部条目提及并集写进 events.mentions**、服务端在 handleInbound 里把 @token 与在册成员 id 精确匹配（UI 与 curl 都不用懂成员表）→ orchestrator 的 mentionHints 首次有了真实数据来源；冒烟：@a_analyst 入暂存 → /commit → 事件 mentions=["a_analyst"]。③`/commit` 报 `cannot get property "commands" without inject` —— teamspace 插件 inject 漏 'commands'（P3 教训在同一形状上复发， lesson：**RPC 数据函数里摸到的每个服务也都要进插件 inject**）。九门禁全绿 | 教训：严格注入检查对「闭包里持有的 ctx」一样生效——不是只在 apply 顶层；staging 条目是合并前的人类发言载体，@ 提及必须随条目持久化才能在 commit 时合并（不造 UI 层的假数据） |

| 2026-09-28 | **P4 四轮返工（视觉与交互，用户实测「太简陋」）**：装无头 chromium（playwright-core + chromium-headless-shell + Noto CJK 字体）**自己看页面、自己操作页面**迭代四版。①时间线换 `el-timeline`（作者彩签 human 蓝/agent 绿/system 灰 + 时间轴 + 自动滚到最新），弃 k-comment 大色块；②轮次状态换 `el-descriptions`（边框表格：暂停原因/说明/调用次数/已委托）；③卡片统一 `el-card shadow=hover`（注意：**el-card 的 header 是插槽不是 prop** —— 写进 props 会把槽函数序列化成文本渲染，实测踩中）；④输入区一行化：作者选择 + 发送 + **/commit 快捷按钮** + 回执彩签 + 暂存清单；⑤成员卡 `el-space wrap` + 角色配色（DRI 绿/目标 agent 蓝）。交互自测脚本 `scripts/snap-page.mjs`（截图）+ `scripts/interact-test.mjs`（发消息/点 @ 候选/提交）进仓库自用 —— 无浏览器环境也可以机器看页面 | 教训：**「chunk 200 + SSR 通过」都代替不了真浏览器截图** —— 用户看到的才是真的（铁律 2 的终局形态是自己先当自己的用户）；h() 手写渲染里 props 与 slots 一之差就是静默的排版事故，截图迭代是唯一可靠回路 |

| 2026-09-28 | **P4 五轮返工（自适应宽度，用户指出「没有自适应屏幕宽度，怀疑没按铁律来」）**：自查坐实——①页面根误用 `k-content`（外壳给它 max-width 55rem 居中，是设置文档页容器，仪表盘被锁在 880px 窄条里）；②页面没有渲染 `k-layout` —— 外壳 theme 把页面组件**直接裸渲染在顶层**，官方 home/settings 都是页面自己渲染 `<k-layout>` 当根，不渲染就没有顶栏、不占导航右侧区域。修复：根改为 `k-layout(main='page-teamspace')` → `div.content-area`（外壳共享类：flex column 占满）→ `el-scrollbar.content-body`（flex:1 内部滚动）→ `el-row`（**el-col 响应式断点 xs=24 / md=16·8**：宽屏双栏、窄屏自动叠单列）+ 输入区在滚动区外固定底部。宽 1440 / 窄 800 两档截图实测通过；铁律 1 逐条自查：样式来源 = 组件 props + 外壳共享布局类（content-area/content-body 是 layout.scss 的现成原语），零内联样式、零样式文件、零手写令牌，lint:styles 七断言全绿 | 教训：**「自适应」不是 el-row 加百分比就有** —— 外壳对页面宿主的隐式包装（或不包装）决定一切；选型表说「容器/布局原语首选 k-*」，k-layout 才是页面级容器，k-content 只是文档排版容器，用错一级宽度就锁死。反驳「怀疑没按铁律」的方式是把铁律逐条对代码过一遍并留下截图证据 |

| 2026-09-28 | **P4 六轮返工（输入联想，用户指出「/ 没有提示、@ 不合业界惯例」）**：①`seam/space-command` 补 `list()`（注册表是指令清单唯一出处，界面不许硬编码）；②teamspace entry 增 `commands()` RPC；③统一联想菜单：输入 `/`（行首或换行后）浮出**指令联想**（名 + usage，随输入前缀过滤，点选补全成 `/name `），输入 `@` 浮出**成员联想**（id/角色名子串过滤，点选替换 `@token` → `@id `）—— @ 从「结尾触发的静态栏」改为业界惯例的「token 实时过滤联想」。无头浏览器交互自测：`/`→6 条指令带 usage；输 `c` 过滤剩 4 条；点选 /cur → 草稿 `/cur `；`@a` → 只剩 3 名含 a 的成员 | 教训：联想菜单的数据源必须是注册表（`list()`），UI 层硬编码指令清单 = 两处漂移；token 级实时过滤（正则锚定结尾）才是用户预期的「提示」 |

| 2026-09-28 | **P4 七轮返工（交互质感，用户指出「观感不符合业界」）**：①块级联想面板 → **el-popover 浮层**（virtual-triggering 锚定输入框真实 DOM、placement top-start）——组件库已有的浮层能力就 Unity 该用（铁律 1 判红条件「组件库已有现成能力却自己造一个」的反向自查）；②**完整键盘导航**：↑↓ 换选中项（文本按钮 type 高亮）、Enter/Tab 补全、Esc 关闭、菜单关闭时 Enter 直发 / Shift+Enter 换行；③回执改 el-alert（success/error 可关闭）；④暂存条目改 closable el-tag（点 × = 发 /del，服务端再校验 not_author）；⑤输入行右对齐（el-row justify）。tsconfig lib 补 DOM（client 代码有 KeyboardEvent/HTMLElement 类型）。无头实测：`/`→浮层 6 条带 usage；↓×2→Enter 补全成 `/del `；`@ch` 过滤只剩挑战者 | 教训：观感差距的本质常是「交互完备度」（浮层/键盘/焦点管理）而不只是配色；组件库的浮层/定位类组件（popover/tooltip）就是为这类场景准备的，绕开它们自己排面板才是违背铁律 1 的「自己造」 |
| 2026-09-28 | **P3 完成（协作大脑，人类授权制状态机）**：①`seam/space-orchestrator` 词汇补真（承旧 `domain/coordinator.go`：`DecisionCase` 四分支 / `Delegation` 单槽位 / `PlanRequest{humanText, mentionHints, targets}` / 回合状态机 `Turn{state, decisionCalls, delegatedTargets, stopReason, stopDetail}` / 暂停点 `await_human` / `OrchestratorBrain` 接口 + `'orchestrator/pause'` 内核事件）；②`policy/space-authz` 新建（**纯函数零 IO**：授权名单 = 在册目标 agent 三角色且协调者必不在、三级兜底解析 0 合法 JSON → 1 纯文本只回复 → 2 坏 JSON 正则救回 → 3 明说「将转达 X」用人类原话补委托、负面语气/多目标/空输出护栏每次 Warn 留原文；解析器只转述不越权拒绝，名单裁决归引擎）；③`plugins/orchestrator`（`ctx.orchestrator` 提供者 + `ctx.on('staging/plan')` 原地接管，接缝零改动；每回合恰好一次大脑调用、委托前宣告「已收到指令，将委托[target]：…」、`reportFeedback` 后强制 `await_human`；回合状态进程内存——用户拍板，重启回 static 安全默认；只读口 GET `/api/sessions/:id/turn` 供 P4 右栏与验收探针）；④大脑接口**返回原始文本**而非结构体（三级兜底必须打在真模型输出上才有意义；P3 拍板不含真实 LLM 适配器，验收用桩离线重放——承旧 Coordinator interface 门禁口径）；⑤3.7 允许表 plugins 行扩到 `policy`（组合点引用纯函数）；⑥`scripts/verify-orchestrator.ts` **52 断言进 gate（第八门禁）**，红测三组各自会红（见 P3 行）；⑦`npm run gate` 八门禁全绿 | 核心教训：**cordis 严格注入检查**——apply 里摸到的每个服务都必须出现在 `inject`，漏了报 `cannot get property "server" without inject` 且**只进 5172 日志页（data/logs.db），控制台与启动日志全静默**（本次排查靠 logs.db 定位）；「未配置大脑 → 暂停零调用（decisionCalls=0）」承旧口径，Part B 断言曾与此相矛盾，按旧口径修正。三项用户拍板：不含 LLM 适配器只留接口、回合状态进程内存、verify 进 gate |
| 2026-09-28 | **P2 完成（指令族 + 暂存区，首个交互能力）**：①`seam/space-command` 补真（`Invocation`/`Reply`/`CommandCtx`/`Command` 注册契约：usage 必填否则注册即炸、aliases、minArgs/maxArgs；`parse` 只认行首 `/`、大小写敏感、`rest` 保留原文空格；`CommandError` 三类：unknown 带可用清单 / duplicate 重名即炸 / bad_args 带 usage）；②`seam/space-staging` 补真（`Entry`/`StagingError` not_found·not_author·empty_text / append·list·remove·update·count·clear·`commit` 契约；`Events` 增补 **`'staging/plan'` 内核事件**）；③迁移 `0004_staging_entries`（FK sessions `ON DELETE CASCADE`、唯一索引 `(session_id, seq)`、down 删表——暂存草稿无历史价值，与 events「留表不回滚」刻意不同）；④`SqliteStagingStore`（seq=max+1 删除不重排；`commit` 把「换行拼接合并→落 events→清空→发信号」绑死在同一方法，空暂存返回 null 零事件零信号）；⑤两个叶子插件（用户拍板）：`command-bus`（`ctx.commands` 唯一提供者）+ `staging-commands`（6 指令回执 + POST `/api/sessions/:id/messages` 入站路由 + GET `/staging` 只读）挂 `cordis.yml`；⑥`scripts/verify-staging.ts` **44 断言进 gate**（用户拍板；Part A 进程内机制 30 条 + Part B HTTP 接线 14 条，全过留痕 action_log）；⑦**验收全过**：verify 44 过/0 红；红测改坏（临时删 emit）→ 3 红退出码 1 → 还原复绿；迁移 down→up→再 up 幂等（v4→v0→v4→无变更）+ seed 重播 9 行幂等（down 清业务表后种子须重播——迁移语义正确行为）；`npm run gate` 七门禁全绿；5172 数据库页 4→5 张表 | 核心教训：**cordis 服务代理重绑 this（栈帧 `Proxy.xxx` + `Object.apply` at cordis/lib/index.js:141），Service 类 `#` 私有字段品牌校验必炸**（`Cannot read private member #planCbs`；Part A 直连实例、服务进程走代理，故只在线上 500 暴露）——TS `private`（编译期）字段安全；跨接缝信号弃回调注册表改走**内核事件总线**（seam 声明事件、impl `ctx.emit`、verify `ctx.on`），更惯用、接缝更薄，P3 orchestrator 以 `ctx.on('staging/plan')` 原地接管。三项用户拍板：/commit 拼接成一条+清空暂存、两叶子插件、端到端验收脚本进 gate |
| 2026-09-28 | **P5 完成（组合收敛）**：①三 bundle 包落位（space-base 核心 9 行 + space-surface-debug M1 套件 8 行 + space-surface-teamspace 4 行，注释随行迁移，package.json 声明 `cordis.bundle.patch`）+ `profiles/{debug,teamspace}` 用户层（当前空根 `[]`）；②`src/compose.ts` 组合引擎：层收集（base 钉最前 + 字母序 + 用户层）、断言 ③ 台账（bundle 层间 / 用户层文件间 / 总层数>2 判红）、同 id 后层整项替换（不深合并）、`compose-cli.ts` 出 `--lint` 与 `--out` 两种形态；③**!!js 不求值往返**：照抄 plugin-include 的 JsExpr 语义，读入包 `{__jsExpr}` 标记、写出还原 `!!js` 原文，求值时机完全留给 loader（零语义漂移）——用 js-yaml 5.4.2 新 API `defineScalarTag` + `JSON_SCHEMA.withTags` 实现（顶层就是这个新大版本，无 `yaml` 包、无 4.x `Type` API）；④接线：`src/index.ts` 启动即 compose（fail fast）→ `config/app.yml` 的 `configPath` 指产物 `composed.cordis.yml`（项目根，gitignore），删旧 `cordis.yml`（等价对照背书：按 id 逐项 JSON 相等含 `!!js` 原文）；⑤断言 ③ 落 `scripts/lint-patch.sh` 进 gate（第十门禁，列 lint:deps 后）+ action_log 留痕；⑥`npm run gate` 十门禁全绿 | **拓扑两项用户拍板**：方案 A 单进程多面、5173 保持未启用（验收按「5172/5174 两实 + 5173 预留」）。**关键发现两条**：plugin-include 把 ctx.baseUrl 覆写为清单文件所在目录（lib/index.js:425）——产物放 `data/` 会让 `./plugins/...` 相对路径与 loader-webui 依赖扫描全部失锚（实测启动即崩 data//package.json），产物必须落项目根，恰是 3.1 节「cordis.yml 退化为叠加结果」的原地置换；loader 层原生支持行级 `disabled: true`（entry.options.disabled），用户层停用语义零成本。红测两条均已实测（层间同 id 判红复绿；用户层停 debug-database-webui → 数据库页 chunk 404、check:console 退出码 1 → 还原复绿） |
| 2026-09-29 | **P6 规划草案落表（未开工）**：用户提出架构级需求（Coding Agent 可插拔入驻）并拍板「先落规划」。落表四处：§3.2 新增 `space-agent` / `space-workdir` 两缝草案；§5 新增 P6 行（两条不变式：开会功能不回退 + 入驻=纯新增）；§6 新增断言 ⑪ 草案（入驻白名单 + 开会回归）；§7 新增决策 8 行 + 待定 8~10（工作区缝语义 / 任务回路 / 提示词接入——等原文）+ 拟升铁律 4 待拍板。需求原话与飞书截图已登记 project memory（截图备份 `ai-handover/需求-2026-09-29-角色提示词与实验冲突.png`） |
| 2026-09-29 | **P6 开工（待定 8/9 拍板 + 铁律 4 建档）**：用户三项拍板——待定 8 = 新缝 `space-workdir`；待定 9 = 先做人类 `@` 最小回路（stub 回执，orchestrator 委托随后）；拟升铁律 4 = 写入 `IRON-RULES.md`（机器人可插拔入驻 + 开会功能不回退）。发现 D2（铁律 3 正文缺位）记账。下一步：P6-1 缝声明 |
| 2026-09-29 | **P6-1~P6-4 完成（多智能体入驻核心闭环）**：①`seam/space-agent` 补真（AgentDescriptor{kind: meeting\|coding} / 生命周期状态机 STATUS_TRANSITIONS / 入驻退驻心跳 / AgentError 四码）+ `seam/space-workdir`（WorkdirHandle / path_escape 铁则，实现留待下轮）；②`plugins/agent-registry`（ctx.agents 唯一提供者，机制行进 space-base——P6 一次性建设，此后新增 agent 不改既有文件）+ `plugins/agent-coder-stub`（首个 Coding Agent：报到 agent.coder + `/tell @名字或id <任务>` 直派回执，状态机走满 idle→working→done→idle）+ `packages/bundle/space-agent-coder-stub/` 自带 patch 一行（**入驻 = 纯新增的形状证据**，compose 扫描自动发现，23 行清单 +2）；③断言 ⑪ 落 `verify:agents`（十一门禁，列 verify:orchestrator 后）：Part C 白名单扫描 + Part A 进程内 21 断言 + Part B HTTP 5 断言；④红测两组实测会红。**红测①抓真 bug 一个**：扫描根错位（import.meta.dirname 是 scripts/）= 扫空集空断言，修正后闭环——恰证「空断言一律不接受」 | **待定 8/9 用户拍板**（新缝 / 人类 @ 最小）；P6-5 提示词接入等用户原文；space-workdir 实现与 orchestrator 委托留下一轮 |
| 2026-09-29 | **团队空间 Web UI 三区骨架改版（用户拍板方案落地，未提交）**：①**新增包 `space-client-ui-sessions`**（左侧会话栏：新会议主动作 + 会话列表按状态分组「进行中/已结束」+ 底部当前身份 DRI；不注册页面，client 经外壳 `router.slot` 挂到整页预留槽位 `space-teamspace-sidebar`——入驻 = 纯新增，铁律 4 精神）+ `space-surface-teamspace` patch 加一行 `client-ui-sessions`；②整页 `space-client-ui-teamspace` 重排三区骨架：薄顶栏（k-layout #header/#menu 槽：折叠开关 + 会话标题 + 状态徽章 + 协作面板呼出）、消息列居中限宽（外壳 k-content 类 55rem）、人类消息右对齐 el-card 气泡 / agent 平文 + 角色标签、时间戳默认隐藏悬停 el-tooltip 显示、composer 悬浮卡片化（/commit 并入斜杠联想、身份下拉移除改由会话栏底部承载、卡片下方一行小字提示暂存语义）、右面板改 el-drawer 默认收起（轮次状态 + 可@成员数据口径不变）；③既有交互全保留（暂存回路 / @ 与 / 联想浮层 + 键盘导航 / 回执 / mentions 持久化 / handleInbound 同路径 / space-api 只读口不动）；④会话选中态走 URL `?session=`（跨 entry 唯一真相源，免跨包共享状态）；⑤`seam/space-ui` PanelSlot 扩 `left`（词汇演进）；⑥`types/cordis-client.stub.d.ts` 补 `useContext/useRouter/useRoute/slot/views` 外壳 API 台账；⑦build-web/check-web 登记新包。门槛自证：gate 十一门禁全绿、`npm run build:web` 双包出 dist、无头浏览器截图 + 交互自测（宽/窄两档 + 抽屉 + 新会议） | 用户 2026-09-29 拍板改版方案（参照豆包/DeepSeek 三区骨架）；新包入驻用外壳 KSlot 视图机制（`client/plugins/router.ts` 的 views 注册表），停用 bundle 行 = 左区自然收空，整页照常工作 |
| 2026-09-29 | **团队空间 UI 回炉修复（交互验收缺陷 9 项，未提交）**：①键盘状态机重写（单一 handler 无竞态）——Shift+Enter 先于一切分支放行恒换行；菜单开（有候选）Enter/Tab 恒确认选中项（activeIdx 起始 -1 不预选高亮，↑↓ 才产生选中，未选过确认第 0 项）；菜单关裸 Enter 直发；**deriveMenu 空匹配折算成关闭**（空浮层是「@ 原文直发」竞态温床，回炉实测复现后根治）；②暂存条目 × 从 el-tag 内置 close 改为显式 IconBtn（内置 close 是内部 SVG，点击命中歧义 + 无法标 aria-label，实测三次精确点击零反应）——新抽 **shared `IconBtn`**（el-button text + 外壳 k-icon + aria-label，同一视觉语义第二次出现按铁律 1 入 shared）；③composer 卡片 el-card → **k-card**（外壳原语自带 8px 圆角 + --k-card-bg=--bg-elevated + --k-card-shadow，全 props 零手写）；④回执从整行 el-alert 降为行内小标签 + 文本 + 关闭按钮（「雷霆提示框挤占空间」，可见性不打折）；⑤slash 菜单项统一渲染、无预选常亮主色；⑥侧栏折叠包 el-collapse-transition 标准件；⑦空发送文案分流（「请先选择或新建一个会议」/「请输入内容再发送」）；⑧tooltip 实测弹出且内容正确（作者·时间），保持结构。回归自测 scripts/ui-verify.mjs 九项全过、零页面错误；gate 十一门禁全绿 | 证据链：p1probe 实测定性（force 点击才生效 = 命中歧义；菜单关闭态换行正常 = 失败场景在菜单开启；0 匹配浮层仍 visible + 原文直发复现；popper 实际可弹）→ 修复 → p2verify 复验九项全绿 |
| 2026-09-30 | **团队空间 UI 二次回炉（仲裁打回 3 项 + 测试数据清理）**：①**Shift+Enter 恒换行**——旧写法裸 return 依赖浏览器默认动作，合成事件（测试注入）不触发默认动作 → 零换行；改为 preventDefault + 在光标处显式插 \n（insertNewline，读 selectionStart/End），真实键盘与注入双路径确定；②**时间戳悬停**——弃 el-tooltip 传送门（popper 弹出在长会话下不确定，仲裁实测 0 popper），改 hoveredId 状态驱动的行内揭示（mouseenter/mouseleave，「作者 · 时间」渲染在消息 content 内，零 popper 机制）；③**侧栏过渡**——el-collapse-transition 本就在且工作（0.3s max-height）；仲裁「无过渡」与锐化断言前的假绿同源：全局 transitionstart 计数被按钮 hover 颜色过渡污染；AS3 锐化为只认 aside 自身的 max-height 过渡事件，破坏态实测 [ ]（红）→ 还原 [max-height]（绿）；④**断言自证**（scripts/ui-verify.mjs，会红实证）：AS1 红证据=旧构建合成注入 "SY1" 无 \n → 绿="SY1\n"；AS2 红=悬停无行内揭示 → 绿=隐藏/揭示/消失三态全过；AS3 红=[SABOTAGE-PROBE] 旁路过渡组件构建 → aside 过渡属性=[] → 还原后 [max-height]（铁律「故意改坏会红」）；⑤测试数据清理：s_b78c6e0b1b8d 会话 + seed 会话 seq=83（R2AR2B 提交发言）+ 暂存残渣，走 node:sqlite 数据层 DELETE（不动物表结构），record-action 留痕。@ 空匹配直发原文维持现状（用户拍板）、Seq 不重排不变 | 判定依据：recon 探针（defaultPrevented 检测 + 合成注入 + transitionstart target 过滤）；Shell 工具偶发双重执行曾致「补丁报 count=0 实则已写入」，以 grep/Read 权威核实为准 |
| 2026-09-30 | **团队空间 UI 第三轮回炉（真实 CDP 先复现后修复，合成事件自证作废）**：①**时间戳悬停两轮未兑现的根因坐实**——hoveredId ref 误声明在 render 闭包体内（页面 4s 轮询等任何重渲染都重建 ref，悬停状态随渲染丢弃，揭示条件永不成立）；真实 CDP 复现（真实鼠标+5s 驻留无揭示）后修法：ref 上移 setup 体，跨重渲染存续；另发现自测探针自身缺陷：timeline 自动滚底后首条消息在视口外，elementFromPoint=null 悬停落空——断言补 scrollIntoViewIfNeeded；②**折叠过渡弃用动画**（用户拍板决策树：卡顿一票否决）：真实 CDP 取证本机过渡事件齐全（run/start/end 300ms）+ 10 步交互 max 241ms 无卡顿，但仲裁环境实测零过渡事件 + 10-170s/步病态，确定性优先 → 移除 el-collapse-transition 改瞬时折叠；③**断言红绿链**（scripts/ui-verify.mjs 重写为真实浏览器方法）：AS2 红=[SABOTAGE-1] ref 移回 render 体 → 揭示=false → 绿=true；AS3 红=[SABOTAGE-2] toggle noop → 折叠=false → 绿=true + 10 步 [54,51,10,3,150,87,135,38,61,59]ms max=150ms；④残留清理：seq=79「验收测试…」数据层 DELETE + record-action 留痕 | 流程教训：合成事件直注 handler 的自证与真实浏览器两次脱节——本轮起自证一律真实 CDP（几何中心+elementFromPoint 校验+跨轮询驻留）；上轮 AS2 假绿的机理即 ref-in-render，探针恰好在重渲染间隙读到了瞬态 |
