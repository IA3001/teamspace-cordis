# 开发历史：从起步选型到当前版本

[返回概览](README.md) · [证据索引](sources.md)

## “历史开源”具体指什么

| 资料 | 本次确认的内容 | 不能推出的结论 |
| --- | --- | --- |
| Git | 完整非 shallow 可达历史；21,405 个提交、一个可达根提交；扫描全体标题/时间及主线 | 可达根之前没有内部工作；作者时间等于首次公开时间 |
| Agent Notes | 1,224 份日期笔记，生命周期/类别目录，理由与替代方案；部分保留验证结果 | 每份都是某个 Agent 原始对话；文件名日期就是上线日 |
| Skills / 指令 | Git 树中 16 个 `.agents/skills/**/SKILL.md`；根和子树开发规则 | 每条指令在所有工作中都被执行 |
| 测试回放 | `snapshots/` 中 600 个 `.jsonl` 或 `.jsonl.zstd` 文件，包括子会话与历史代际 | 600 次开发会话；它们都是原始研发日志 |
| 事故复盘 | 有真实 GUI Agent 会话 ID 与事件序号，有外部失败现象和修复路径 | 原始会话全文也公开，或该经历代表全部开发 |
| PR / CI | Git 中有合并号、源码中有工作流和测试；部分笔记给出 run ID | 完整审批链和全套 CI 日志都可公开获取 |

上述文件计数由固定 Git 树获得。[baseline.json](evidence/baseline.json)；记录如何组织见 [S03](sources.md#s03)，回放用途见 [S15](sources.md#s15)。研究不能通过“AI 风格文案”或署名猜测 Agent 贡献比例。

## 起点：Cordis 不是后来才接入的

- `b67e81ac97647270b3002d78532baf3a5b68cbc3`：2026-06-10 初始化 README、AGENTS 与 CLAUDE 符号链接。
- `804eede9eb36a1275dd30a59bdc2a3a5eea5fbd1`：当天的指令已明确基于 Cordis，并链接飞书 MVP 需求和微内核方案。这两份设计正文此次无法访问。
- `ae2e08b4d66d7d9a3365966dc0f6b3ddc4e81780`：2026-06-11 monorepo 起步，用 Yarn 4、tsc -b、dumble、Vitest。
- `72688a38886978f4a5e3a62ed53061d8b2a40331`：随后将 Cordis 框架源码 vendor 进来。
- `d5a1d9bb7599ce58834ac5a1073c2dbc18653451`、`43f425827781b95a1b66d7b3121b199e012ab9ad`：抽象服务与 Agent 循环进入源码。

这是提交顺序证据 D。当前 pnpm/tsdown 是后续状态，不能写成从第一天就使用。[vendor 决策](sources.md#s06)解释了冻结框架内部行为与本地修补的需求；完整“为什么一开始选 Cordis”的会议过程仍为 U。

## 重要转折表

表中日期以实现提交为主；设计首次提出时间另列。短 SHA 只是便于阅读，链接与机器记录保留完整 SHA。

| 时间 | 变化 | 前后差别与代价 | 提交证据 |
| --- | --- | --- | --- |
| 06-10～11 | Cordis 起步、vendor、接口与循环 | 配置组合服务取代一个独占核心；同时承担框架同步维护成本 | [72688a](https://github.com/deepseek-ai/deepseek-harness/commit/72688a38886978f4a5e3a62ed53061d8b2a40331) |
| 06-12～13 | 能力角色明确化 | bash 已分接口/实现/工具消费者，之后记录三角色及何时拆包；不强制为每个概念预拆包 | [8b5a3e](https://github.com/deepseek-ai/deepseek-harness/commit/8b5a3ef7300e5b100c66268f9c761c660172b298)、[39b3db](https://github.com/deepseek-ai/deepseek-harness/commit/39b3db4b9cc3668cf4ce285f8d262978fe720efc) |
| 06-14 | doc-sync 落地 | 从人工检查文档，变为示例编译与事件名集合验证；笔记首次提出日期是 06-11 | [6a528b](https://github.com/deepseek-ai/deepseek-harness/commit/6a528be5695deb9b5207477948f0110d588c8c01) |
| 06～07 月 | 上下文压缩、子 Agent、目标与动态能力扩展 | 能力围绕服务与事件增长；“可替换”也增加恢复、取消与边界管理要求 | [压缩参考](sources.md#s49)、[Goal 参考](sources.md#s46)；只确认能力及决策记录，不以文件名代替全部上线时间 |
| 07-22 | 缩小本地 hooks | 取消 commit/push 重复全套验证；Agent 选择相关行为证据、CI 负责全面矩阵 | [31c058](https://github.com/deepseek-ai/deepseek-harness/commit/31c0589439ed9d35edde8320da1bf9a005c41a53)，主线 #509 |
| 07-24，07-27 合入 | 上下文与执行分开 | 多个附加上下文入口收束为 sourced message；注入不再等同开启一次执行 | [992cf8](https://github.com/deepseek-ai/deepseek-harness/commit/992cf894af8033050714c09d172b5df78e60ac8e)，主线 #585 |
| 07-29，08-02 合入 | GUI 开发反馈闭环 | Agent 获知当前 GUI 地址与运行模式，禁止裸 Vite 假成功，验证原服务页面 | [cd88a3](https://github.com/deepseek-ai/deepseek-harness/commit/cd88a339fa885be82194e1881f49bf8be46190fe)，主线 #830 |
| 08-06 | 可分发的 profile bundles | `base/web/headless` 用 bundle 的 patch 构成配置树，manifest 进入 `dsh.profile/dsh.bundle` | [2365b2](https://github.com/deepseek-ai/deepseek-harness/commit/2365b2c54f3369acc8cd4de905377da2daef9c2d)、[62d0f2](https://github.com/deepseek-ai/deepseek-harness/commit/62d0f26fd68a0b49307f78affd140dad971432f5) |
| 08-23 | SDK 应用 bundle | 同一产品基础上增加 JSON-RPC 运行面，而不是另建一套 Agent 核心 | [a16822](https://github.com/deepseek-ai/deepseek-harness/commit/a16822944b01770a64c55bfdb0a0808164e0d0dc) |
| 08-26 | Session projection 组合补齐 | 持久事件派生状态成为显式服务依赖，减少“没有投影服务就悄悄降级” | [e296e7](https://github.com/deepseek-ai/deepseek-harness/commit/e296e79b185344854d8d972c2a06a4a1c76654a4) |
| 08-31，09-03 合入 | 已发布 Session 迁移 | 非稳定产品也承担已写用户数据兼容责任；版本代际不可覆盖 | [d1521e](https://github.com/deepseek-ai/deepseek-harness/commit/d1521ea7838f19a78a9cca7b4a93622d301149bb)，主线 #3400 |
| 09-01 | v2 嵌入紧凑 Assistant stream | 流片段从大量独立持久事件转为消息内紧凑流，UI 增量帧与持久结算分开 | [f99b06](https://github.com/deepseek-ai/deepseek-harness/commit/f99b06eaed81d6fe4fc64d44687450e18ef68a67) |
| 09-06 | 迁移改为 streaming stages | 整个 artifact 多次展开/复制改为状态化转换，降低巨大会话迁移峰值；性能故事发生在首次方案之后 | [a84a8d](https://github.com/deepseek-ai/deepseek-harness/commit/a84a8da9e19ee3a2f7530c3114c1164248d23755) |
| 10 月基线 | 持久化兼容性与性能验证继续演进 | 当前 writer 为 v4；同版本变更也要求实际读者安全证据；增加时间、内存、规模性能门禁 | [兼容性规则](sources.md#s42)、[测试职责](sources.md#s15) |
| 10-09 | 0.2.1-alpha.2 发布提交合入 | 这是本次固定的根包版本，仍属快速迭代阶段 | [基线提交](https://github.com/deepseek-ai/deepseek-harness/commit/d743267388641bc76f17c45ce8b4c231aed1d32c) |

“提案时间、实现提交、主线合入、产品发布”四者不能混写。案例的主线合入通过 first-parent 历史与祖先关系计算，不是从文件名猜测。[cases.json](evidence/cases.json)

## 怎么读它的历史，才能学到设计

先看同一问题的早期提交，再看修复与当前 owning note。`implemented` 笔记会同步当前路径/术语；不能拿它今天的内容当作当时原文。`archived` 保留封印时的历史状态，也不能当作当前行为权威。[S03](sources.md#s03)

例如 doc-sync 最初是事件名集合比对，后来事件/服务目录由源码生成；今天的检查数量与最初两项完全不同。上下文注入笔记后来又收束了事件和消息形状。会话迁移最初的 whole-artifact API 与当前 Stage API 也不同。只读最终 architecture.md 会错过这些失败和简化。

公开 Git 记录足以确认结构先后及修复 diff；它没有提供足够资料计算 Agent 编写代码占比、研发人时节省比例或完整审查通过率。提交数量与星数不作为效率指标。
