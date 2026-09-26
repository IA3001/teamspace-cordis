# 铁律（Iron Rules）

> **常看，常注入。**
> 本文件是铁律的**唯一出处**。任何其他文件、注释、README、Agent 指令里出现的「铁律」都只是引用；
> 冲突时以本文件为准。
>
> - **常看**：每次开工前、每次提交前读一遍（见文末检查表）
> - **常注入**：注入到人和 Agent 的上下文里
>
> 建档：2026-09-27 ｜ 沿用同类工程（`teamspace`）的既有结构：正文只写在这里，别处只放指针。

---

## 铁律 1　web 端 UI 禁止手写 / 自制样式

**原话（用户指示，2026-09-27）**：

> 关于 web 端的 ui ，我有铁律：禁止手写/自制 样式，
> 也就是说，必须有一套统一的，快捷的（也许可以预定义/或者使用已有的 ui 轮子库，比如蚂蚁的 ui）
> 反正就是，样式的封装越简洁越好（就像面向对象先定义好类和属性封装好，然后用的时候直接 new 一样，
> 而不是用的时候直接现写，导致屎山代码，），这也是为了我的系统主题风格一致

### 约束地位：这是**根本前提**，不是建议

用户原话：

> 以上的内容必须是根本的前提，如果上方的内容无法做的完美，不符合我的预期，就禁止下面的事情进行

也就是说：**这条做不到位，web 界面相关的工作就不许开工。** 不存在「先写出来再慢慢重构样式」。

### 为什么是铁律

样式一旦允许「用的时候现写」，每个页面都会各自发明一套间距、颜色、圆角。
三个月后的结果不是「样式有点乱」，而是：

- 改一次主题要翻遍所有页面，没人敢改 → 与「系统主题风格一致」这个**目标本身**直接冲突
- 新页面靠复制旧页面的样式开始，错误随之复制 → 页面越多，回圈越贵
- 说不清「这个圆角为什么是 6px」→ 无法判断哪些是设计意图、哪些是随手写的

用户的类比很准确：**组件库 = 类，props = 构造参数，设计令牌 = 属性定义。**
用的时候只负责「new」，不负责重新定义类。

### 落地动作（每条都可检查）

1. **先定组件库，再写界面。** 选型未定之前，**不许开始写任何界面代码**。
   定了就写死在本文档的「选型」表里，不许在两个页面上用两套。
2. **样式的来源只有三个，不允许第四个**：
   - 组件库组件的 props（`size` / `type` / `variant` / `status` 之类）
   - 组件库的布局原语（`Row` / `Col` / `Space` / `Flex` 之类）
   - 项目设计令牌（语义化的颜色 / 间距 / 圆角 / 字号）
3. **业务代码里禁止出现**：
   - 内联样式：`style={{ ... }}`、`style="..."`
   - 自写样式块：`<style>`、独立 `.css` / `.scss` 文件
   - 硬编码视觉值：`#RRGGBB`、`rgb()`、`hsl()`、以及裸的 `px` 间距与圆角
4. **封装成「类」，而不是在页面里现写。**
   同一视觉语义出现第二次，就必须抽成组件或令牌；
   页面只做**组合**，不做**定义**。
5. **主题一致性靠令牌。** 亮 / 暗两套值只在令牌里定义一次，
   业务代码只引用语义名（如 `--color-bg-surface`），不引用具体色值。
6. **要有会红的门禁断言。**
   扫描 web 业务源码，出现内联样式 / 自写样式块 / 硬编码颜色 → 判红。
   断言必须**故意改坏一次确认它真的会红**（空断言与源码文本匹配一律不接受）。
   落地实现：`scripts/lint-styles.sh`，跑 `npm run lint:styles`。
   它扫 `src/`、`plugins/`、`packages/`、`web/`（`docs/`、`node_modules/` 不扫，与本文件「适用范围」一致）。
   已实测的三种改坏方式见脚本末尾「自检记录」。

### 判红条件

- web 业务代码里出现内联样式，或自写的样式块 / 样式文件
- 出现硬编码的颜色、间距、圆角、字号
- 组件库已有现成能力，却自己造一个
- 同一视觉语义在不同页面用了不同实现
- 门禁里没有对应的「样式来源」断言

### 选型（定后写死在这里，不许漂移）

**定于 2026-09-27，依据用户选择「用官方 webui 栈，我们零 UI 代码」。**

| 项 | 值 | 状态 |
|---|---|---|
| 组件库 | **`element-plus@2.7.7`**（由外壳 `app.use(Element)` **全局注册**，`<el-*>` 直接可用）+ **外壳全局注册的 `k-*` 组件集**；`@cordisjs/components@0.4.0` 只补充 `k-comment` / `form` / `virtual-list` | ✅ 已定 |
| 平台外壳 | `@cordisjs/client@0.8.2` + `@cordisjs/plugin-webui@0.8.2` | ✅ 已定 |
| 设计令牌出处 | 外壳 `@cordisjs/client/app/styles/index.scss` 定义的**语义 CSS 变量**（亮 / 暗两套，229 行）。**本仓库不新增任何令牌文件、不覆盖外壳主题** | ✅ 已定 |
| 样式门禁 | `scripts/lint-styles.sh`（`npm run lint:styles`） | ✅ 已建 |

**这个选型的特殊之处：我们写的 UI 代码是 0 行。**

调试控制台要的三个页面，全部由官方 webui 页面插件提供，且每个包**自带预构建好的
`dist/manifest.json`**（无需自己跑 Vite）：

| 页面 | 提供者 | 注册方式 |
|---|---|---|
| 插件系统查看 | `@cordisjs/plugin-loader-webui@0.10.1` | 包内 `apply` 调 `ctx.webui.addEntry(...)` |
| 日志系统 | `@cordisjs/plugin-logger-webui@0.6.1` | 同上 |
| 数据库系统 | `@cordisjs/plugin-database-webui@0.5.0` | 同上 |

因此「禁止手写样式」不是靠自觉遵守，而是**结构上就没有可以下手写的地方**。

> ⚠ 上面这条只保证**当前**三个页面 —— 它们由官方页面插件提供，我们一行 UI 代码都没写。

### 选型扩展：我们自己写页面时（定于 2026-09-27）

上一版这里写的是「将来若必须自己写 UI，就回到本表重新选型」。**这一天到了** ——
团队空间的**时间线 / 输入区 / 右栏**官方没有现成页面。于是就地重定，结果如下。
全部依据 `@cordisjs/client@0.8.2` 的实测源码（路径写在各行「依据」列），不是推测。

**结论：不引入第二套组件库。外壳里已经装好了 element-plus 和整套设计令牌，我们直接用。**

| 项 | 值 | 依据 |
|---|---|---|
| 容器 / 布局原语（**首选**） | 外壳全局注册的 `k-*`：`k-layout`、`k-card`、`k-content`、`k-slot`、`k-slot-item`、`k-tab` / `k-tab-group` / `k-tab-item`、`k-empty`、`k-hint`、`k-status`、`k-button`、`k-icon`、`k-activity-link`、`k-markdown` | `@cordisjs/client/client/components/index.ts`（`app.component('k-…')`，见其中 `layout` / `slot` / `link` / `common` / `icons` 五个子插件） |
| 表单 / 控件（**次选**） | `el-*`（element-plus 全量）：`el-row` / `el-col` / `el-space` / `el-divider` / `el-scrollbar` / `el-input` / `el-select` / `el-tag` / `el-dialog` / `el-tooltip` … | 同上，第 4 行 `import Element … from 'element-plus'` + 第 28 行 `app.use(Element)`；第 12 行加载 `element-plus/dist/index.css` |
| 消息渲染 | `k-comment` | `@cordisjs/components/client/k-comment.vue` |
| 共享件 | `@cordisjs/components@0.4.0` 只提供三样：`k-comment`、`form`（由 schemastery 生成表单）、`virtual/list.vue`（虚拟列表）。**它不是完整组件库 —— 完整组件库是 element-plus** | `@cordisjs/components/client/` 目录清单（只有 `index.ts` / `index.scss` / `k-comment.vue` / `form/` / `virtual/`） |
| 设计令牌 | **只用外壳 `app/styles/index.scss` 的语义 CSS 变量**（亮 / 暗两套） | 同左 |
| 令牌白名单 | 背景 `--bg-{primary,secondary,tertiary,elevated,hover,active}`；文字 `--text-{primary,secondary,tertiary,inverse}`；边框 `--border-{primary,secondary,focus}`；语义色 `--accent{-hover,-muted}` / `--success{-muted}` / `--warning{-muted}` / `--error{-muted}` / `--info`；圆角 `--radius-{sm,md,lg,xl}`；阴影 `--shadow-{sm,md,lg}`；字体 `--font-sans` / `--font-mono`；过渡 `--color-transition` | `app/styles/index.scss` |
| **禁用的令牌层** | `--k-*`、`--bg0`–`--bg3`、`--fg0`–`--fg3`（Koishi 遗留层）与 `--el-*`（element-plus 自己的层）。外壳**已经把 `--el-*` 映射到设计令牌**，我们只写设计令牌，让映射层去转 | `app/styles/element.scss` 头注释原文：「Map el-* tokens onto the design-system tokens so el-* components visually align」 |
| 本仓库新增令牌 / 样式文件 | **仍然是零。** 不新增 `.css` / `.scss`，不覆盖外壳主题、不改外壳源码 | 铁律 1 落地动作 5 |
| 页面插件契约 | 服务端 `apply(ctx)` 调 `ctx.webui.addEntry({ baseUrl: import.meta.url, source: '<dev 入口>', manifest: '../dist/manifest.json' })`；客户端入口由 Vite 构建出 `dist/`（含 `manifest.json`） | `@cordisjs/plugin-webui` 的 `Entry.Files`；官方样板 `@cordisjs/plugin-loader-webui` 的 `dist/{index-*.js, index-*.css, manifest.json}` |
| 封装粒度 | ① 页面只做**组合**，不做**定义**；② 同一视觉语义出现**第二次** → 抽成组件，放进 `packages/client-ui/space-client-ui-shared`；③ 抽出来的组件也只准用上表的原语 + 白名单令牌 | 铁律 1 落地动作 4 |

**为什么不用第二套组件库（比如蚂蚁的 ui）**：外壳已经把 element-plus 的 `--el-*`
全部映射到设计令牌，同一页面再引一套组件库，必然出现「两套令牌、两套圆角、两套间距」——
正是铁律 1 要消灭的东西。**想换组件库 = 换外壳，不是加一套。**

**选型扩展后追加的判红条件**：

- 代码里出现 `--k-*` / `--bg0`–`--bg3` / `--fg0`–`--fg3` / `--el-*` → 判红（用错令牌层）
- 出现外壳 `app/styles` 之外的第二个令牌来源 → 判红
- 在页面 / client-ui 包里 `import 'element-plus'`（外壳已全局注册，再引一份就是两套） → 判红

### 适用范围

- ✅ **覆盖**：web 端产品界面 —— 调试控制台（`DEBUG_PORT`）、控制台、团队空间。
- ⚠ **不覆盖**：文档类静态页（如 `docs/architecture.html`）、终端 / 日志输出。
  这条铁律针对的是**产品界面**，不是一次性文档。
- ⚠ **不覆盖**：`node_modules/` 下第三方包自带的样式。但那不等于可以改它们 ——
  改第三方包源码等于给自己埋一个升级即爆的雷，见「修订记录」。

---

## 常看 / 常注入

### 开工前

- [ ] 读本文件
- [ ] 要动 web 界面吗？→ 组件库选型定了吗？样式来源是不是只有「组件库 + 令牌」两个？
- [ ] 要自己写页面吗？→ 组件是不是从 `k-*` / `el-*` 里挑的？令牌是不是白名单里的？
      （`k-*` 和整套令牌都已经由外壳注册好了，**没有什么需要我现写的**）
- [ ] 要写的东西，官方 / 组件库有没有现成的？（不要手搓）

### 提交前

- [ ] 界面改动没有引入内联样式、自写样式块、硬编码颜色
- [ ] 没有用错令牌层：没有 `--k-*` / `--bg0`–`--bg3` / `--fg0`–`--fg3` / `--el-*`
- [ ] 没有在页面 / client-ui 包里 `import 'element-plus'`（外壳已全局注册）
- [ ] 同一视觉语义没有出现第二套实现
- [ ] 新增的样式约束有**会红的**断言

### 注入点

| 注入点 | 注入什么 | 为什么 |
|---|---|---|
| `AGENTS.md`（开工第一份被读的文件） | 铁律清单 + 指向本文件的指针 | 保证任何人 / Agent **开工会读到** |
| 每个 Agent 的 system prompt（运行时） | 铁律精简版 | Agent 自己也会跳过约束 |
| 提交前检查表 | 上面的提交前清单 | 提交时就拦 |

> 注入内容以本文件为准，其他地方只做**引用**，不复制正文，避免多处漂移。

---

## 铁律本身的修订

- 铁律的**表述**由用户定，未经用户明确要求不得改动语义。
- 落地动作可以随实践补充，补充时在下方「修订记录」记一行。
- 若某条落地动作被证明是错的或过贵的，**先在这里删掉**，再删代码 —— 不留「人人都违反的规则」。

### 修订记录

| 日期 | 修订 | 原因 |
|---|---|---|
| 2026-09-27 | 建档，铁律 1（web 端 UI 禁止手写 / 自制样式） | 用户要求把这条铁律放到正式位置，作为 web 界面工作的根本前提 |
| 2026-09-27 | 选型表填定：组件库 = `@cordisjs/components`（+ element-plus / uno），令牌 = `@cordisjs/client` 外壳统一注入，门禁 = `scripts/lint-styles.sh` | 用户选择「用官方 webui 栈，我们零 UI 代码」，M1 前置门槛由此满足 |
| 2026-09-27 | 落地动作 6 补上脚本落点与扫描范围 | 门禁从「要求」变成「可执行」，并明确 `docs/` 不扫以对齐适用范围 |
| 2026-09-27 | **选型扩展**：解决「自己写页面」的选型（MODULE-PLAN 待定 1）。不引入第二套组件库 —— 组件 = element-plus（外壳已 `app.use` 全局注册）+ 外壳 `k-*` 组件集；令牌 = 外壳 `app/styles/index.scss` 的语义变量白名单；追加 3 条判红条件（用错令牌层 / 第二个令牌来源 / 重复 import element-plus） | 团队空间的时间线、输入区、右栏官方没有现成页面，「将来再说」的那一天到了；实测外壳源码后重定 |
| 2026-09-27 | 门禁扫描范围加上 `packages/`（`scripts/lint-styles.sh`） | `client-ui` 页面包将落在 `packages/` 下，不扫就等于没覆盖 |