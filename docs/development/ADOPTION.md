# DSH 开发机制采纳矩阵

范围：Agent 开发本项目。上游固定为 `d743267388641bc76f17c45ce8b4c231aed1d32c`。证据编号链接到[研究索引](../research/dsh-agent-native/sources.md)，这里记录适配实现，不把产品内 Agent 运行能力纳入目标。

| 上游机制 / 来源 | 本项目适配 | 验收 / 状态 |
| --- | --- | --- |
| 根/局部 Agent 指令 S02/S14 | 根 AGENTS 导航，plugins/packages/docs 局部导航 | 链接检查、技能发现；已实施 |
| 能力边界发现 S04/S07 | 现有 L0–L12 与 AST 层级门禁，生成依赖目录 | verify:ci 违规 import 负例；保留，不重构业务 |
| pre-push 相关验证 S11 | gate:related、完整 gate 分工 | 依赖闭包与全局 fallback 负例；已实施，旧检查关联未知时保守全选 |
| 独立 review S12 | space-review、任务 review 版本绑定 | 拒绝自审/过期版本；独立 Agent 实际审查另记录 |
| CI 可靠性 S13 | 有界进程、状态与准备失败处理 | 超时、依赖跳过及隔离副本负例；已实施 |
| prose / 简化 / 错误处理 skills | 九个本地技能保留范围、证据与维护成本判断，沿用复杂度预算 | skill-creator 校验；不复制泛化规则 |
| scope / diff / rule protection S35–37 | 保留可信基线预算，检查删除、放宽文档/覆盖/重复基线会失败 | verify:development/verify:ci；初次引入需独立审查 |
| weighted blame scoring S35 | 简化为静态变更策略、真实行为检查与机器门禁 | 不采用积分算法或模型审查；检查结果绑定当前代码版本 |
| DAG / 并行 / abort S18 | 检查 id、needs、资源锁，静态并发2，runtime共享资源串行 | 周期/缺依赖/锁/中止负例；已实施 |
| 结果与性能反馈 S18/S45 | receipt绑定HEAD/源码指纹，逐项耗时/日志 | 收据过期失败；基线完整门禁58项通过；不宣称固定加速倍数 |
| md links / budgets S24/S27 | 中文字节预算、相对链接/锚点；生成文档分片 | 缺锚点负例；保留现有20KB改动预算 |
| 类型/JSDoc 等价 S25 | Babel AST比较ToolInvoker/ToolResult，字段注释纳入 | 类型、JSDoc改坏失败；稳定接口先覆盖，非全仓等价声明 |
| 文档例子编译 S26 | 用当前TS7编译公共工具接口例子 | compile负例；无“示例能编译即产品正确”断言 |
| 工具/配置/模块目录 S31–34 | AST提取工具描述、RPC参数、Config与空间包导入，确定性分片 | docs:generate/gate:docs；未覆盖动态值的运行解释，明确指回源码 |
| archive seal S29 | 兼容登记中的archive hash与可信base比对 | 改坏历史/登记负例；已实施 |
| 双语i18n S30 | 中文权威 | 不采用双语管线，本项目无维护需求 |
| skill invocation metadata | 九技能YAML frontmatter与根导航；实际任务/收据另存 | 元数据不当执行收据；已实施 |
| 会话恢复 / 目标（开发侧借鉴） | 开发task/checkpoint/resume、版本失效规则 | 文档及代码夹具中断恢复演练；不采用产品Goal服务 |
| 并行开发/stacked PR S50 | 独立工作树、作者/审查者分离；任务依赖以Git基线及scope记录 | 不自动改别人的工作树；不引入自动合并工具 |
| 真实Loader与ACP事故 S44 | engineering-consumers走实际Loader/Include注入与disposer | 原调用路径测试；错注入/清理失败会红 |
| Web自用地址事故 S43 | UI验收绑定origin与从磁盘manifest读取的实际chunk hash | 错端口/错构建/无加载负例；主页面行为与异常继续验收 |
| snapshots/expected/replay S15/S19 | 保留已有行为fixture，增加v31→当前迁移夹具 | upgrade-fixtures、备份恢复；不引入DSH会话格式 |
| release/persistence S41/S42/S51/S52 | 源码变化ack、旧版本/升级/回退/测试登记；发布准备不发布 | 兼容负例及真实升级；已实施 |
| runtime closure / NodeNext S53/S56 | 现有typecheck、依赖检查、prepare:release、release-start | 不增加未提供给用户的SDK发行面；沿实际消费者验证 |
| real API / e2e S21 | 保留人工显式在线评测入口；默认CI空模型Key | 不使用付费Key跑本轮门禁 |
| coverage/jscpd S38–40 | 原有类型/复杂度检查＋精确函数块重复基线；两工程模块V8范围覆盖基线 | 新重复/覆盖下降失败；不是全仓100%或语义克隆检测 |
| vendor/upstream S05/S06 | 真实安装Cordis组合语义对照；独立文档记录差异 | 不整体vendor；当前compose是层替换，不是Include指令语法 |
| 发布平台强制保护 | GitHub Actions 提供自动 CI 反馈 | 当前按单人直接推送运行，不要求 PR 审批；Actions 结果不拦截已完成的 push，见 PLATFORM |

## 本轮实际边界

默认提供源码与文档机械一致性、受控隔离执行和可定位结果；自动检查无法证明所有语义决策都正确，GitHub Actions 也只是推送后的反馈。PR 逐项人工批准和生成式模型审查都不作为目标。

真实消费者测试与已有行为回归相补充，保留源码结构/防泄漏扫描；不批量删除它们。接口等价范围在 `.ci/docs.json` 明列，新公开接口可逐步加入，生成目录已穷举可静态识别的注册点。覆盖率测量只针对两个新的工程基础模块，不给整个产品打100%覆盖标签。

[开发流程](WORKFLOW.md) · [平台缺口](PLATFORM.md) · [CI](../CI.md)
