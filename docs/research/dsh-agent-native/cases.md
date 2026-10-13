# 六个变更案例

以下均以固定基线中的提交、源码和笔记为证据。实现提交与第一次进入 first-parent 主线的提交分开记录；笔记文件日期不能直接当作上线日期。完整 PR 审查正文未恢复，因而“审查”只报告可见的合并和后续修正，不补写批准者意见。[案例机器索引](evidence/cases.json) · [证据索引](sources.md)

## 1．架构：把能力拆成 Definition / Provider / Consumer

**问题与变化。** Cordis 注入服务并不自动决定包的职责。把操作系统实现、抽象接口与 Agent 工具放进同一包，会让实现替换同时牵动工具协议。初期 bash 能力先形成三段：抽象 shell 服务、本地/沙箱提供者、面向 Agent 的 bash 工具；随后决策笔记明确三种角色。

- 早期实现：[8b5a3ef7300e5b100c66268f9c761c660172b298](https://github.com/deepseek-ai/deepseek-harness/commit/8b5a3ef7300e5b100c66268f9c761c660172b298)，2026-06-12。
- 规则与文档整理：[39b3db4b9cc3668cf4ce285f8d262978fe720efc](https://github.com/deepseek-ai/deepseek-harness/commit/39b3db4b9cc3668cf4ce285f8d262978fe720efc)，2026-06-13，当日主线可见。
- 公开决策：[能力边界笔记](sources.md#s07)。它允许角色在同一包内折叠，只有不同变化速度、替换需求或边界需要时才物理拆分。

**收益与代价。** 工具消费稳定接口，替换运行环境无需重写工具；代价是更多注入关系与包间契约。它不是“一个角色必须一个包”的模板。

**验证与 Agent 证据。** 当前 CI 有能力图、注入及客户端边界检查；这不能反推最初提交已经具备今天的完整门禁。文档整理提交含明确的 review 语境，但没有本案完整 Agent 操作会话；实现主体、每步审查过程未知。本次没有重跑初期实现测试。

## 2．架构：将上下文注入与新任务分开

**问题与变化。** 上下文补充如果走普通 follow-up，会把“给下一步提供信息”变成“唤醒一次新工作”，混淆生命周期、拒绝处理与持久化。新结构区分非唤醒的 context 输入与会启动/引导工作的 follow-up、steer，保留进入模型上下文的可追踪事件。[上下文决策](sources.md#s08)

- 提案：[31fb3a3f44ea75ced79a9191708d4b6ffd016e91](https://github.com/deepseek-ai/deepseek-harness/commit/31fb3a3f44ea75ced79a9191708d4b6ffd016e91)，2026-07-24。
- 实现：[992cf894af8033050714c09d172b5df78e60ac8e](https://github.com/deepseek-ai/deepseek-harness/commit/992cf894af8033050714c09d172b5df78e60ac8e)，2026-07-24。
- 首次主线：[5b5f089bd041a388cc415812eb12324ef968c4a3](https://github.com/deepseek-ai/deepseek-harness/commit/5b5f089bd041a388cc415812eb12324ef968c4a3)，2026-07-27。
- 后续修正：[admission 时路由](https://github.com/deepseek-ai/deepseek-harness/commit/a59ce0367c4cffb62b7c84ee2eb9bdd8170c1844)、[拒绝后结算 context](https://github.com/deepseek-ai/deepseek-harness/commit/98238ceacee61cb438facec0126c81fc75d2e101)，均在 2026-07-27。

**验证与取舍。** 差异涉及会话事件、输入处理及相关测试；后续提交说明最初分拆仍有 admission/rejection 边界需处理。当前笔记描述了后续完善后的契约，不能逐句归到首次实现。更多事件类型增加消费者适配成本，换来“补充材料”和“派任务”的明确语义。Agent 参与程度无完整会话支持；本次只复核源码与历史，未执行旧版本测试。

## 3．流程/CI：文档从提醒变成可执行契约

**问题与变化。** 修改类型和事件却忘记更新文档，仅靠“记得同步”无法稳定阻止漂移。初期引入可编译 TypeScript 文档示例与事件分类验证，后来发展为类型等价、生成工具/配置/模块目录及链接检查。[原决策](sources.md#s09)

- 实现：[6a528be5695deb9b5207477948f0110d588c8c01](https://github.com/deepseek-ai/deepseek-harness/commit/6a528be5695deb9b5207477948f0110d588c8c01)，2026-06-14。
- 首次主线：[204c36ed7631c482a0d3843029dced160b417099](https://github.com/deepseek-ai/deepseek-harness/commit/204c36ed7631c482a0d3843029dced160b417099)，2026-06-14。

**验证。** 当前 `doc-sync` 构造出 43 个检查，并非初次提交就有 43 项。本次使用原脚本在隔离夹具中确认：链接锚点失效返回 1；文档接口 `value: string` 改成 `number` 返回 1；正确版本返回 0。执行链见 [CI](ci.md)，逐项输出见 [验证证据](evidence/verification.json)。

**取舍与 Agent 证据。** 可编译示例仍可能讲错行为，类型等价也不能校验设计叙述。生成与检查减少手工同步，但增加标注和生成器维护。笔记是约束设计证据，不是 Agent 已实际遵循全部约束的操作回放；PR 内部审查不可核实。

## 4．流程/CI：缩小本地阻塞，保留完整 CI

**问题与变化。** 全量 pre-push 的高成本拖慢迭代。2026-07-22 改成较快本地钩子，完整检查变成主动命令与 CI 职责；之后恢复可选择的 all-gates，而非再次强制所有推送阻塞。[钩子决策](sources.md#s10) · [当前 pre-push skill](sources.md#s11)

- 实现：[31c0589439ed9d35edde8320da1bf9a005c41a53](https://github.com/deepseek-ai/deepseek-harness/commit/31c0589439ed9d35edde8320da1bf9a005c41a53)，2026-07-22。
- 首次主线：[08d3895a07423c79feb854ac956ec27c81a96389](https://github.com/deepseek-ai/deepseek-harness/commit/08d3895a07423c79feb854ac956ec27c81a96389)，2026-07-22。
- 后续：[恢复 opt-in 全量门禁](https://github.com/deepseek-ai/deepseek-harness/commit/2405570ac85e92302ddc305bd3374735fe5de2e6)。

**另一项成本证据。** 7 月 30 日消费者构建笔记记录 static 排队 8m01s、运行 1m41s，consumer 排队 10m34s、运行 1m58s，因此让 consumer 自己拥有 Linux 构建、取消等待 static 的跨 job 依赖，同时仍只构建一次。这是维护者对特定运行的记录，不能算本研究实测，也不能推导固定加速倍数。[原始记录](sources.md#s45)

**取舍。** Agent 需主动选择相关验证，远端完整门禁必须保留；少跑本地检查不是无条件安全。当前 DAG、缓存及取消过时执行帮助降低重复成本，实际净收益缺少连续可比数据。没有公开完整 Agent 执行收据证明每次都运行 skill 要求。

## 5．兼容性：已发布会话格式与大文件迁移

**问题与变化。** 会话持久化格式改变后，旧用户产物不能只靠当前 writer 读写自洽。新增已发布 generation、相邻转换及兼容性记录，把发布历史变成迁移输入。[迁移决策](sources.md#s41) · [后来的安全 reader 规则](sources.md#s42)

- 实现：[d1521ea7838f19a78a9cca7b4a93622d301149bb](https://github.com/deepseek-ai/deepseek-harness/commit/d1521ea7838f19a78a9cca7b4a93622d301149bb)，2026-08-31。
- 首次主线：[b4ea3efcf6b8c3f7d392eebdb71e19ce29ba103e](https://github.com/deepseek-ai/deepseek-harness/commit/b4ea3efcf6b8c3f7d392eebdb71e19ce29ba103e)，2026-09-03。
- 后续流式迁移：[a84a8da9e19ee3a2f7530c3114c1164248d23755](https://github.com/deepseek-ai/deepseek-harness/commit/a84a8da9e19ee3a2f7530c3114c1164248d23755)，2026-09-06。

**实故障与修正。** 笔记记录一份约 116 MB 压缩会话展开为约 914 万事件，whole-artifact 方式耗尽约 16 GB Node 堆；后续改成流式 stage。原笔记日期不能拿来代表流式改造日期。基线 writer 为 generation 4，发布登记与变更登记通过独立脚本校验。

**取舍与验证。** 格式代际、转换链和 reader 审查提高兼容可解释性，也增加维护旧版本的成本。检查登记完整不等于所有历史数据均能迁移。本次复核实现及记录，没有执行生产大文件迁移；故障的数值属于维护者记录。没有本案完整 Agent 开发对话。

## 6．故障：Agent 改了自身 GUI，却验错了端口

**问题与实际行为。** 公开 postmortem 引用真实 DSH Web session UUID 和事件序号：Agent 在原 GUI 3081 中工作，但工作目录与模型可见信息未说明该运行面。它要求用户替它验收；又验证独立 Vite 5173 的 HTTP 200，页面因缺少 `__DSH_BOOT__` 白屏；接着启动未受管的 3334 替代服务器，把另一个端口的成功当成任务完成，而原 3081 已有变更。[事故全文](sources.md#s43)

- 修复：[cd88a339fa885be82194e1881f49bf8be46190fe](https://github.com/deepseek-ai/deepseek-harness/commit/cd88a339fa885be82194e1881f49bf8be46190fe)，2026-07-29。
- 首次主线：[f8eb6a9b84c235d341cbff68bfd01e3c5e1f1893](https://github.com/deepseek-ai/deepseek-harness/commit/f8eb6a9b84c235d341cbff68bfd01e3c5e1f1893)，2026-08-02。

**旧/新结构。** 以前 Agent 只有通用 shell/文件能力，没有原页面的运行身份；修复后提供模型可见、写入会话的 canonical Web surface 和 `DSH_WEB_URL`，裸 Vite 缺少启动配置时在监听前拒绝，并补真实 HMR、启动及原运行面验收测试。差异含 27 个文件、438 行新增、89 行删除。

**反例仍需反例测试。** 起初用 timeout 杀掉 Vite 的“启动失败测试”可错误地通过，后续补自然退出和监听断言。因此可复现的错误输出、真实进程行为及原地址浏览器验收比 HTTP 200 更有证明力。

**Agent 参与与局限。** 这是六案中最明确的产品自用行为证据，包含选定事件位置；未找到完整原始开发会话，不能计算所有尝试、耗时或总体自用比例。本研究未重跑全套浏览器回放。当前项目此前出现端口变化和 UI 白屏，与这个错误类型相近；相似不是同一根因的证明。

## 案例共同结论

六案覆盖能力边界、输入生命周期、文档契约、本地/CI 分工、发布兼容与真实 GUI 验收。公开材料可以解释规则如何形成，却不足以量化 Agent 对全部代码的贡献或独立审查覆盖率。另一个 [ACP 事故](sources.md#s44)显示 178 项单测通过、覆盖率 100% 仍漏掉真实 Loader 的注入问题，进一步支持“沿实际消费者路径验收”的建议。
