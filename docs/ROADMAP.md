# 路线图（ROADMAP）

> 本文件是**「接下来做什么、做到什么程度算完」的唯一出处**。
> 铁律见 [`.rules/IRON-RULES.md`](../.rules/IRON-RULES.md)　·　怎么跑起来见 [`README.md`](../README.md)
> 建档：2026-09-27

> **状态说明（2026-10-09）**：下方按日期记录的是实现历史，不代表今天仍在使用旧页面或旧认证模型。当前 Admin 与 Team 使用独立身份、会话和 API；Admin 管理系统设置、账号与日志，Teamspace 管理共享 Agent 目录、邀请和会话。`npm run gate:static` / `npm run gate:runtime` 是当前门禁。旧记录中 `/commit`、`/tell`、`is_admin`、5174 Admin bridge 和 `/agents` 管理页均为历史实现。会议与 coding Agent 均已作为共享目录数据由通用运行时加载；LangGraph 工具循环、隔离工作区、按 Agent 并行的消息记忆、Inbox 启动回放、SQLite 跨进程活动会话租约、越界审批、DRI 决策与因果撤回/重做、主动发言节流和活动 Tab 已有实现。后续重点是 Orchestrator/确定性流程作业恢复、可达 Embedding 服务上的检索对比和 UI 体验收尾；详见根目录 [`TODO.md`](../../TODO.md) 与 [`Problem.md`](../../Problem.md)。

---

## 现状

**M1 已完成**（2026-09-27）：调试控制台在 5172 跑起来了，三个页面都是真实运行时数据。

- `src/index.ts` 只做启动，零业务
- 业务插件：`plugins/health`（`GET /healthz`）、`plugins/app`（试金石，打印一行日志）
- 设施插件（`cordis.yml`）：`server`(8080) + `debug-server`(5172) + `debug-webui`
  + `plugin-loader-webui` / `plugin-logger-webui` / `plugin-database-webui` + `plugin-database(-sqlite)`

**IM 化协作改造已落码**（2026-09-30，用户拍板）：多账号注册登录（users/login_tokens，
迁移 0007 + `plugins/space-auth`）、消息直达时间线（`/stage` `/commit` 降级为可选）、
websocket 实时推送（`plugins/space-push`，`space/event-appended` → 5174 broadcast）、
AI 自治回合（去强制 await_human，自治预算默认 8，超限 `budget_exhausted` 暂停）、
AI 主动发言（`ctx.messages.send` 统一入口）、微信式聊天列表与 `/login` 登录页。

**分层架构固化**（2026-09-30，用户拍板）：L0~L12 层模型 + 横切层建档于
`docs/ARCHITECTURE.md`；`space-tool`/`space-memory` 补真、`space-retrieval`/
`space-context` 新建（迁移 0008 建 memories 表）；判红器 `scripts/lint-layers.sh`。

**三轮体验迭代**（2026-09-30 ~ 10-01）：/help、回合记忆自动沉淀
（`plugins/memory-recorder`）、消息搜索、引用回复、导出 Markdown、草稿持久化、
桌面通知、会话置顶/免打扰、未读红点+定位、AI 记忆透明面板、自治预算进度条、
「AI 正在工作中」指示、空会话引导、登录记住用户名、消息撤回、@所有人、
文件消息（`plugins/space-upload`）、表情回应（迁移 0009 建 msg_reactions）、
人类「正在输入」广播、新成员入会欢迎、Ctrl+K 快速切换会话、
回合视图（`plugins/space-dialog`）、AI 消息 Markdown 渲染（shared/md.ts）、
`/summary` 一键会议纪要（`plugins/ai-summary`）、种子提示词换成可用默认文案、
确定性服务流程指令（`plugins/flow-commands`：/code /test /review，MC 式多 Agent
接力）、/todo 团队待办（记忆层存储）、未读数进标签页标题、搜索命中高亮、
可见即已读兜底、服务流程进度卡片（el-steps）、`npm run backup` 备份脚本、
配置全面面板化（schemastery Config：LLM/Embedding/Agent 身份/flows/预算/白名单/
上传/注册开关——5172 面板在线改并保存）、知识库域（迁移 0010 + space-kb + 检索
三源接入 + /kb 管理页）、Embedding 实现（`space-embedding-openai`，EMBED_* env
兜底）、账号管理（迁移 0011 is_admin + 首用户自动管理员 + 5172 /admin 页）、
外接 New API 网关已于 2026-10-09 退役，后续由后台独立配置文字模型、Embedding 与网页搜索 API。
**模型与接入设置页**（2026-10-05）：schemastery 原生配置表单对本地 ts 插件渲染
不出（面板显示「此插件尚未安装」），改走自建通道 —— `ctx.settings` 设置缝
（seam/space-settings，同步 KV；impl 落 sqlite settings 表，迁移 0013）+
5172 `/models` 页（LLM/Embedding 的 baseURL/model/apiKey 表单 + 连通测试；
apiKey 只写不回显）。取值优先级：settings（面板）> Config > env。保存即生效，
无需重启。路由避开面板内置的 /settings（通用设置），故用 /models。
**Agent 配置页**（2026-10-05）：5172 `/agents` 页（admin 同口径）—— 名册
（注册表全量 + 生命周期状态）、提示词模板编辑（ctx.prompts upsert，下一回合
生效）、per-agent promptRef 重定向（settings 键 agent.<id>.promptRef，
agent-analyst-llm 现读）、自治预算（settings 键 agent.autonomyBudget，
orchestrator 闸门现读）。
**真实模型端到端打通**（2026-10-05）：阿里云 MaaS（qwen3-max + 
qwen3.7-text-embedding 1024 维）经 /models 页配置后，@需求分析师 → 真大脑
派单 → 【真模型】回复全链路验证通过。附带修复：@提及解析放宽（@角色/@分工
显示名也认，服务端与客户端双端；末尾标点剥离）—— 此前手打 @标题 不会触发
AI（mentions 只认内部 id）。
**对话质量与 UI 打磨**（2026-10-05 晚）：协调者输出契约修正 —— @点名 = 明确
授权，大脑是调度员不得在 reply 里代答（此前 qwen3-max 会抢答/复读历史）；
Agent 成果单次落库（analyst 此前 messages.send + reportFeedback 同文双发）；
回合收尾回声抑制（大脑复述成果原文 → 引擎最后一道闸丢弃）。UI：成员面板
chip 短名不再裁切、引用块旧格式裸 id 换显示名、@菜单 hint 显示角色、composer
textarea 禁 resize、文件按钮加回形针图标。诊断：大脑原始输出落 logs.db
（排「答非所问」必须看得到它）。
**控制台专业版式**（2026-10-05 深夜）：/admin /models /agents 三页统一设计
语言（shared/client/console.ts + im.css「控制台专业版式」段）—— 页头（标题+
职责描述+状态胶囊+页级导航）、分区卡片（主色竖条标题+浅描边微阴影）、双列
表单栅格、虚线分隔操作行+内联结果、灰/橙/绿/红语义状态点；保存/测试结果从
大 alert 改为内联与细条；暗色模式（light-dark 令牌）同步适配。
**5174 侧打磨**（2026-10-05 深夜）：登录/注册页净化（.sp-plain 藏外壳
global-nav 与 layout-activity，:has 选择器）；已登录态从默认空盒插画改为
居中分区卡；会话栏彩色头像（id 哈希色相，去掉「新」字首字）；新增
历史实现：space-client-ui-bridge（5174 /admin → 5172/admin?token= 跳转，DEBUG_PORT
取端口，延迟 replace 防外壳启动竞态）；该桥接页已于 2026-10-09 退役并从工作区移除，后台现通过独立管理入口访问。
**知识库页修复**（2026-10-06）：/kb 白屏两连（client 少 import ThemeStyle；
useRpc 是 ref，全部 rpc.* 调用漏 .value —— 该页自上线即不可用）；灌文档
FOREIGN KEY 必炸（kb_chunks 先于 kb_documents 插入，顺序颠倒）；检索命中
标题字段名对齐（doc_title）。页面视觉纳入 console 设计语言。另有：零消息
空会话清理（先 backup 再删 5 条测试空会话）。
**配置面板化 + 账号体系完善**（2026-10-02）：schemastery Config 声明（LLM/
Embedding/Agent/flows/预算/白名单/上传/注册开关，5172 面板在线改）、知识库域
（迁移 0010 + space-kb + 检索三源 + /kb 管理页）、账号管理（迁移 0011 is_admin +
首用户自动管理员 + 5172 /admin 页 + 登出/账号管理入口）、消息长度上限 5000、
CORS 中间件（`plugins/space-cors`）、回复关系字段（迁移 0012 reply_to + 结构化
引用块 + 点击定位）、冒烟脚本 `scripts/smoke.sh`（8 项全过）。

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
