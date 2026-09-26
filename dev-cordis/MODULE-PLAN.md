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
├─ cordis.yml                      组合根 = bundle 层叠加的结果         （现状，P5 收敛）
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
| `space-event` | `ctx.events` | `domain/event.go` | 事件模型（append-only）、会话内序号、事件类型注册表 |
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
| `space-workspace` | `ctx.workspace` | `domain/{gantt,story,kickoff,template,disposition,evaluation,summarizer}` | 工作台视图模型（**先合一个包，出现第二个实现者再拆**） |

### 3.3 impl 层（`packages/impl/`）

| 包 | 实现 | 说明 |
|---|---|---|
| `space-store-sqlite` | `ctx.events` / `ctx.session` / `ctx.staging` / `ctx.memory` 的 sqlite 后端 | 承接旧系统 10 张表 + `migrate` / `seed` / `reset`；**表结构改动必须有迁移 + 重置 + 种子** |
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
| `client-ui` | `cordis`、`@cordisjs/client`、`@cordisjs/components`、`seam` 的**类型** | `impl` / `policy` / `bundle` |
| `bundle` | 任意（它只写清单，不写代码） | —— 反向：**任何包都不得依赖 `bundle`** |
| `plugins/` 叶子 | `cordis`、任意 `seam` | `impl` 的具体实现类 |

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
| **P0 立骨架** | `npm workspaces` 接通；`packages/` 五层目录立起；依赖方向门禁脚本 + 实测改坏会红；**每个 seam 包只放一个空的 `Service` 声明**（零业务） | `npm run typecheck` 干净；门禁脚本故意把 `impl` 依赖另一个 `impl` → 退出码 1 |
| **P1 首个真能力** | `seam/space-session` + `seam/space-event` + `impl/space-store-sqlite`（先建 `sessions` / `session_members` / `events` 三张真表）+ `migrate`/`seed`/`reset` | 调试控制台 5172 的**数据库页从 0 张表变成 3 张真表**；迁移 `up→down→up` 幂等 |
| **P2 交互元素** | `seam/space-command` + `seam/space-staging` + 指令族（`/add` `/cur` `/del` `/change` `/clear` `/commit`） | 非 `/` 开头消息只入暂存区、**不触发** coordinator；`/commit` 恰好触发**一次** Plan；未注册指令返回可用清单 |
| **P3 协作大脑** | `seam/space-orchestrator` + `policy/space-authz` | 授权名单外目标 → 拒绝；人类 `@` 指令走 NLP 判定；三级兜底各自有断言；收到目标 agent 反馈后**必须**输出暂停并等人类 |
| **P4 前端** | `seam/space-ui` + `client-ui/space-client-ui-*` | 前置「待定 1」**已解决**（见第 7 节）；`npm run lint:styles` 扫到 `packages/client-ui/` 且全绿。P4 开工时须把铁律新增的 3 条判红条件变成**会红的**断言（见第 6 节 ④） |
| **P5 组合收敛** | `bundle/space-base` + 两个 surface + `profiles/{debug,teamspace}`；现有 `cordis.yml` 退化为叠加结果 | 「同一 id 最多出现两层」断言通过；删掉用户层某行 → 该能力确实消失；5172 / 5173 / 5174 三面并存互不污染 |

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

---

## 7. 待定项与风险

| # | 事项 | 现状 | 为什么是门槛 |
|---|---|---|---|
| **1** | ~~铁律 1 与 `client-ui` 层正面冲突~~ | ✅ **已解决（2026-09-27）** | 选型扩展已定稿并写进选型表：组件 = 外壳全局注册的 `element-plus` + `k-*` 组件集；令牌 = 外壳 `app/styles/index.scss` 语义变量白名单；**不引入第二套组件库**。新增 3 条判红条件（用错令牌层 / 第二个令牌来源 / 重复 import element-plus）。**P4 的前置门槛由此满足** |
| **2** | 前端构建面 | M1 是「用官方包预置的 `dist/manifest.json`，我们不跑 Vite」 | `client-ui` 包需要自己的构建（Vite + unocss）。**注意 `devMode: true` 已实测不通**（`No fs option provided to compileScript`），要定「各包预构建 dist」还是「修 fs 问题吃 HMR」 |
| **3** | seam 包是否发布 | 方案 A 是 monorepo | 建议 **workspace 内私有，不发布**；将来真要发布再开 `publishConfig` |
| **4** | `space-workspace` 拆不拆 | 暂合成一个包 | 出现第二个实现者/第二个消费者再拆，**不预拆** |
| **5** | 授权名单等业务硬约束的落点 | 现在写在 `project_memory` 与本文档 | 应落到 `policy/space-authz` 的**断言**里（第 6 节 ⑥），不要只留在文档 |
| **6** | 旧系统那 10 张表是否原样搬 | 未定 | 建议 P1 只搬 `sessions` / `session_members` / `events`，其余按新 seam 需要再建；**不做「先全搬再重构」** |
| **7** | **「每插件一节」迁移 与 cordis 运行时启停的耦合** | 旧系统是「装不装一个插件，看它的迁移 + 启用开关」；cordis 里插件**可在运行时停用**，但迁移是一次性脚本 | 要定：停用一个插件时，它建的表**留着**（数据不丢）还是跟着回滚？建议**留表不回滚**（cordis 的 `effect` 只回滚注册，不回滚数据），由迁移链自己管版本 |

---

## 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-27 | 建档。调研三个参照系（旧 `teamspace/`、deepseek-harness 240 个包、cordis 官方），定方案 A（monorepo 多包），给出五层骨架 + 依赖方向表 + 迁移映射 + P0~P5 落地顺序 + 6 条门禁断言 |
| 2026-09-27 | 补：迁移口径承旧 `store/doc.go`（按域分文件、插件域用插件名前缀、已提交迁移不许改）；`space-staging` 更正为「旧库尚未建表」；新增待定 7（迁移与运行时启停的耦合） |
| 2026-09-27 | **待定 1 解决**：`client-ui` 层选型定稿，写进 `.rules/IRON-RULES.md`「选型扩展」；门禁扫描范围加 `packages/`（实测通过）；新增 3 条判红条件留待 P4 变成断言 |