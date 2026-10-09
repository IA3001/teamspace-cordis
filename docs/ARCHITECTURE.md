# 分层架构章程（ARCHITECTURE）

> 建档：2026-09-30（用户拍板：插件化 + 分层架构 + 高内聚低耦合）。
> 本文件是**层与依赖方向的唯一出处**；铁律见 `.rules/IRON-RULES.md`，路线见 `docs/ROADMAP.md`。

## 一、总原则

1. **一切皆插件，层即缝（seam）**。每一层由一个或一组 `packages/seam/space-*` 包定义词汇
   （Service 声明 + 数据形状 + 错误分类法，零 IO），实现在 `packages/impl/*` 或
   `plugins/*`。层与层之间只准通过 seam 服务或内核事件总线（`ctx.emit/ctx.on`）说话，
   **禁止跨层摸实现细节**。
2. **依赖只准自上而下**（上层依赖下层，禁止反向、禁止跨层跳跃引用实现包）。
   横切关注（身份 / 授权）单独一层，任何层可用。
3. **高内聚**：一层的所有文件只回答该层的问题；**低耦合**：换掉任何一层的实现
   （如换向量库、换 LLM 供应商）不需要改动其他层的任何文件，只换 impl/插件注册。

## 二、层模型（自下而上）

| 层 | 名字 | seam（词汇） | 实现（IO） | 说明 |
|---|---|---|---|---|
| L0 | **模型层** | `space-llm` | `impl/space-llm-openai` | LLM 适配。只回答「怎么调模型」，不懂业务 |
| L1 | **记忆层** | `space-memory` | `impl/space-store-sqlite`（memories 表，迁移 0008） | 写入/召回/检索/遗忘；scope 三域（session/agent/global） |
| L2 | **检索层** | `space-retrieval` | `plugins/space-retrieval` | 统一事件 FTS 与记忆两个数据源为一个检索面；纯读 |
| L3 | **工具层** | `space-tool` | `plugins/space-tool`（+ 各能力方注册） | 工具注册表 + 受控调用 + 留痕；能力方注册、使用方按名调用 |
| L4 | **上下文注入层** | `space-context` | `plugins/space-context` | prompt 模板 + 最近历史 + 记忆 + 检索 → 一次调用的注入面；预算裁剪只在这一层发生 |
| L5 | **会话层** | `space-session` `space-event` `space-staging` `space-history` | `impl/space-store-sqlite` | 会话/成员/事件（append-only + FTS）/暂存账本 |
| L6 | **Agent 层** | `space-agent` `space-agent-runtime` `space-workdir` | `impl/space-agent-runtime` `impl/space-workdir-local` `plugins/agent-*-stub` | agent 注册表 + 状态机 + 工作区 + 各 agent 插件 |
| L7 | **流转层** | `space-orchestrator` | `plugins/orchestrator` | 回合状态机、委托分发、自治预算；只决定「下一步谁动」，不亲手干活 |
| L8 | **协作层** | `space-message` `space-dialog` | `plugins/space-message` | 任意参与者（含 AI）的发言语义 + 'space/plan' 触发信号 |
| L9 | **输入层** | `space-command` | `plugins/staging-commands` | 入站语义唯一处理体 handleInbound：指令解析 / 直达时间线；文本进系统的唯一大门 |
| L10 | **输出层** | （webui broadcast 词汇） | `plugins/space-push` | 落库事件 → websocket 广播；出口只有这一个 |
| L11 | **显示层** | —— | `packages/client-ui/space-client-ui-shared` | EventItem / IconBtn / labels：纯展示原语，零业务 |
| L12 | **交互层** | —— | `packages/client-ui/{teamspace,sessions,auth}` | 页面组合、RPC 消费、键盘状态机；只认 token 与 seam 数据形状 |
| X | **横切：身份与授权** | `space-identity` | `impl/space-store-sqlite`（users）`plugins/space-auth`；策略 `policy/space-authz` | 登录/token 注入 + 授权名单纯函数；任何层可用，任何层不可绕过 |
| X | **横切：可观测** | —— | `plugins/health` `plugins/app` 5172 控制台 | 铁律 2 的落点：健康检查、调试控制台、action_log |

## 三、依赖规则（可机械检查）

- L4 可依赖 L0~L3、L5；L6 可依赖 L0~L5；L7 只依赖 L6、L8 的缝；L8 依赖 L5；
  L9/L10 依赖 L5、L8；L11/L12 只依赖自身与 RPC/HTTP 契约，**不得 import 任何 impl/policy/seam 服务端包**。
- 同层内互相不 import（层内高内聚靠「一个包只答一个问题」保证，不靠互调）。
- 实现包只准依赖 seam 包与 cordis 内核（`scripts/lint-deps.sh` 的矩阵为准，本章程与它同向）。
- 数据库 DDL 只在 `impl/space-store-sqlite/migrations/`（铁律 ⑧），任何层不得绕过迁移链建表。

## 四、一次发言的分层旅程（读法示例）

```
用户回车（L12 交互层）
→ RPC send(token, sessionId, text)（token 校验 = X 身份层）
→ handleInbound（L9 输入层：/ 指令 or 直达）
→ ctx.eventLog.append（L5 会话层）＋ emit 'space/event-appended'
→ space-push（L10 输出层）广播给所有在线客户端（L12 即时上屏）
→ orchestrator 订阅 'space/plan'（L7 流转层：预算闸门 → 决定委托）
→ agent 插件（L6）受托后：ctx.context.assemble（L4：prompt+历史+记忆+检索）
   ← L4 内部用 L2 检索层、L1 记忆层、L5 事件、L3 工具目录
→ 需要动手时 ctx.tools.invoke（L3）→ 完成后 ctx.messages.send（L8 协作层）发言
→ 再次走 L10 出口广播；回合在预算内自然收敛（completed）
```

## 五、分层落位账（2026-09-30 ~ 10-01 改造动作）

- 补真：`space-tool`（注册表+受控调用+留痕）、`space-memory`（写入/召回/检索/遗忘）、
  `space-history`（事件视图过滤）、`space-dialog`（回合视图）、`space-bus`（外发通道契约）。
- 新建：`space-retrieval`（统一检索面）、`space-context`（统一注入面）。
- 新迁移：0008（memories 表，含 scope 索引）。
- 新插件：`plugins/space-tool`（含 workdir 工具注册 `tool-workdir`）、
  `plugins/space-retrieval`、`plugins/space-context`、`plugins/agent-analyst-llm`
  （首个走全分层组合的真模型会议 Agent：L7 委托 → L4 组装 → L0 单次调用 → L8 发言；
  LLM 未配置/失败回退【占位】，诚实标注）。
- 消费接线：`brain-llm` 优先走 L4 组装（保留协调者输出契约块，组装失败回退手拼）；
  前端（L12）已全部改为 token 鉴权 RPC + socket 实时订阅。
- 章程校验：`scripts/lint-layers.sh`（静态扫描：impl/plugin 源码 import 了非本层允许的包即判红；
  加入 `npm run gate` 的后续接线由门禁负责人决定 —— 本章程先立规矩）。

## 六、反模式（出现即违章程）

1. 页面组件直接 `import` impl 包或自己拼 LLM prompt（应走 L4）。
2. 任何层绕过 `ctx.tools` 直接调 agentRuntime/workdir/LLM（应先注册成工具）。
3. orchestrator 亲手执行任务（流转层只调度，不干活）。
4. 输出侧另开第二个广播口（出口只有 space-push）。
5. 输入侧另开第二个写入口（HTTP POST /messages 与 RPC send 必须共用 handleInbound）。
6. 记忆/检索被 UI 直接读写（UI 的一切数据走 L12 的 RPC 面）。

## 七、AI 触发的双轨制（2026-10-01）

| 轨道 | 入口 | 语义 |
|---|---|---|
| **自由协作**（默认） | 消息 @提及 | L7 orchestrator 自治回合：大脑规划、预算内连续委托，收束 completed |
| **确定性服务流程**（MC 式指令） | `/code` `/test` `/review` 指令 | `plugins/flow-commands`：固定步骤链（如 编码→测试→评审），每步由对应 agent 认领 delegate，结果事件回流自动推进下一步；指令=流程、步骤=agent，无大脑参与 |

两轨共用同一套 delegate/回流/广播机制（L7→L6→L8→L10），只是「谁决定下一步」不同：
前者是大脑（自治预算内），后者是指令定义的固定流程。新增服务流程 = flow-commands
的 FLOWS 表加一行（config.flows 可覆盖），零改码。

**单套 Agent 禁令**（2026-10-01，用户拍板）：Agent 是全服务器单例，**AI（大脑 +
全部 Agent）同一时刻只服务一个会话** —— 自由协作轨在 orchestrator 侧全局持锁
（存在 chain 回合的会话即持有者），其它会话的 @召唤被拒绝并落系统事件告知原因
（不是静默丢弃）；服务流程轨在启动/推进前检查 agent 空闲。多会话可以并存
（当话题/线程用），AI 产能是全局串行资源 —— 这是「一套 Agent」架构的固有权衡。
