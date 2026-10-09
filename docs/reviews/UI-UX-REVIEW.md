# 团队空间前端交互评审（UI-UX-REVIEW）

> **改造状态（2026-09-30，IM 化改造同步修复）**：
> 第 1 条（滚动抢占）✅ 已修 —— 贴底才跟随 + 「回到最新」按钮 + 未读定位；
> 第 2 条（发送 loading）✅ 已修 —— 发送中按钮 loading 且拦截 Enter；
> 第 3 条（空状态闪烁）◐ 部分修复 —— socket 推送取代轮询，首屏仍可能有短暂空态；
> 第 4 条（错误回执弱）◐ 部分修复 —— 成功回执 3s 自动消隐、乐观插入失败回滚，仍是行内提示；
> 第 5 条（身份硬编码 DRI）✅ 已修 —— 真实登录身份（token 注入）；
> 第 6 条（已结束会话可输入）✅ 已修 —— composer 禁用；
> 第 10 条（空输入报错）✅ 已修 —— 静默忽略；
> 第 13 条（复制入口）✅ 已修 —— EventItem 复制按钮。
> 其余条目（7/8/9/11/12/14）未动。
>
> **三轮体验迭代（2026-09-30 ~ 10-01）新增**：消息搜索（FTS）、日期分隔、@提及
> 高亮、草稿持久化、桌面通知（含会话免打扰）、「AI 正在工作中」指示、空会话
> 引导 chips、会话置顶、操作收进下拉、消息引用回复、导出 Markdown、自治预算
> 进度条、AI 记忆透明面板、未读红点+最近消息摘要+作者名、登录记住用户名、
> /help 指令、回合记忆自动沉淀、消息撤回、未读定位、@所有人、文件消息
> （上传/下载/图片内联）。评审原文保留如下。
>
> **2026-10-02 追加**：悬停揭示交互全面废弃（用户反馈惊吓）→ 常显紧凑行 + ⋯ 下拉；
> 视觉重做为聊天骨架（头像+气泡+im.css 样式层，light-dark 自适应明暗）；
> 引用升级为系统级（reply_to 字段 + 结构化引用块 + 点击定位 + 撤回联动）。

> 评审日期：2026-09-30
> 范围：5174 团队空间页面（`packages/client-ui/` 下三个包，约 900 行前端源码）。
> 5172 调试控制台是 `@cordisjs/plugin-webui` 官方外壳自带界面，不属于本项目前端，未纳入。
> 评审方式：逐行源码评审（本环境无可用浏览器后端，未能 GUI 实测）。
> 结论骨架是「确定性优先」的好底子，问题集中在 **异步反馈**（loading 态、滚动抢占、错误提示弱）与 **状态可发现性**（身份固定、已结束会话仍可输入、触屏拿不到悬停信息）两类。

## 高优先级

### 1. 轮询会"抢走"用户的滚动位置
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:305-308`
- 现象：只要事件数变化就无条件 `setScrollTop(999999)` 强制滚到底。用户正在往上翻历史消息时，任何新事件（4 秒轮询随时触发）都会把视口拽回底部，读到哪里完全丢失。
- 建议：贴近底部才跟随 + 偏离时给一个「回到最新」悬浮按钮。

### 2. 发送按钮没有任何 loading / disabled 态，可重复发送
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:526`
- 现象：`sendText` 是异步的，期间「发送」按钮仍可点击、Enter 仍可触发，网络稍慢就会连发两条。
- 对比：会话栏的「确定」按钮做了 `loading`（`sessions/client/index.ts:210`），主输入区反而没有。

### 3. 加载中会闪烁错误的空状态
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:396-398`（切换会话先清空 `events.value = []`，见 `index.ts:200`）；会话栏同理 `sessions/client/index.ts:165-166`
- 现象：首次加载和切换会话期间会显示「还没有事件——在下方输入区发言」/「暂无会议」，一两秒后内容才冒出来，用户会误以为会话真的为空。缺少「加载中」中间态。

### 4. 错误回执太弱，且会被无声覆盖
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:530-535`（渲染）、`:189`（静默清除）
- 现象：所有失败（发送失败、加载失败、业务 `error`）只渲染成 composer 里的一行小字加小 tag，没有用 ElMessage/ElNotification 主动提示；`reply` 是单一变量，下一次操作立即覆盖上一条错误；轮询触发的「加载失败」在下一次轮询成功时被静默清掉，用户可能根本没看见。

## 中优先级

### 5. 发言身份被硬编码为 DRI，无法切换
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:131-132`；身份标签 `sessions/client/index.ts:224-232`
- 现象：`authorId` 永远取会话里的 DRI（缺了降级 `u_dri`），左下角「当前身份」只是展示、没有切换入口。多个人类协作者或想以普通成员身份发言时做不到。

### 6. 对「已结束」会话没有禁言
- 位置：composer 不判断 `activeSession.status === 'closed'`（`index.ts:280-302` 一带）
- 现象：顶栏徽章显示「已结束」（`index.ts:347-350`），输入区却毫无变化，仍可正常输入发送，只能等服务端报错。状态与可操作性脱节。

### 7. 删除暂存条目无确认、且以 DRI 名义发出一条 `/del` 指令
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:484-489`
- 现象：点 × 直接 `sendText('/del N')`。误触即删（/del 可重加），且删除会作为一条消息进入流程/时间线，删除一个草稿产生「发言」的副作用不符合直觉。

### 8. 作者·时间只靠悬停揭示，触屏/键盘用户拿不到
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:383-390`（纯 `onMouseenter/onMouseleave`）；composer 提示行同样只挂 hover/focus（`index.ts:540-546`）
- 现象：平板、手机或纯键盘导航下作者和时间永远不可见，composer 操作提示在触屏上等于没有。

### 9. 轮询是全量重拉
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:179-188`（4s 全量 events/members/staging/turn）；会话栏独立 5s 轮询 `sessions/client/index.ts:134`
- 现象：没有增量、没有游标，会话一长既浪费也放大第 1、3 条问题；两套轮询节奏互不知晓。

## 低优先级

### 10. 空输入按 Enter 会弹错误回执
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:286-289`
- 建议：更自然的做法是静默忽略。

### 11. 新会议对话框文案重复啰嗦
- 位置：`packages/client-ui/space-client-ui-sessions/client/index.ts:186,196`
- 现象：标题「新会议 —— 附加 coding 角色（可多选）」和 placeholder「附加 coding 角色（可多选；不选 = 只开纯会议名册）」几乎逐字重复。

### 12. 异常文案直接透传原始错误
- 位置：`packages/client-ui/space-client-ui-teamspace/client/index.ts:192,300`
- 现象：`String((e as Error).message ?? e)` 在 RPC 层出错时把英文技术报错裸露给用户。

### 13. 消息没有复制入口
- 现象：悬停只揭示「作者 · 时间」，长文本想复制只能手动框选；气泡卡没有「复制全文」按钮。

### 14. 会话不能从界面结束/重命名
- 现象：左栏只有新建和切换，「进行中」的会议没有结束入口，标题永远是服务端默认命名。

## 做得好、应保持的

- 斜杠/@ 联想的键盘状态机完整（Shift+Enter 恒换行、菜单开着时 Enter 绝不直发、空匹配折算成菜单关闭，`index.ts:211-262`）。
- 暂存条目 × 用了带 aria-label 的显式按钮 IconBtn（`index.ts:479-491`）。
- /clear 两段式确认、指令回执文案友好（服务端 `plugins/staging-commands/`）。
- 会话选中态走 URL（`?session=<id>`）可分享、可回退。

## 建议的动手顺序

1. 第 1 条（滚动跟随策略）——改动小、体感提升最明显。
2. 第 2 条（发送按钮 loading）——同样是小改动，堵住重复发送。
3. 第 3、4 条（加载态与错误提示）——一次重构 `reply`/空状态逻辑可一起解决。
