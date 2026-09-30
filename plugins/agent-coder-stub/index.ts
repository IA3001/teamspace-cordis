// agent-coder-stub —— 第一个 Coding Agent 的**入驻示例**（P6 建，P8 收敛）。
//
// 入驻形状（本包就是铁律 4 的证据）：
//   新增 plugins/agent-coder-stub/（本文件）+ 新增
//   packages/bundle/space-agent-coder-stub/（自带 patch 一行，compose 扫描自动发现）
//   —— 既有文件零改动。停用 = 用户层给这行写 disabled: true，同样零改动。
//
// P8 升格（2026-09-30，P6 在案记账的兑现）：coding 类**共享干活路径**
// （perform：领工作区 → 任务落盘 → 状态机 → 回执）与 /tell 直派口从本包
// 升格为机制（seam/space-agent-runtime + impl/space-agent-runtime）——
// 第二、三个 coding agent 入驻后，agent 包收敛为两件事（这正是铁律 4
// 期望的 agent 包形状，本包从此是双 stub 照抄的模式）：
//   ① 报到：apply 时向 ctx.agents 注册描述符（promptRef 绑 prompt.coding，
//      引用与内容分离 —— 换文案零改名单，待定 10 形态）；
//   ② 认领：订阅 'orchestrator/delegate'，target 命中自己（title/id 双口径）
//      就调 ctx.agentRuntime.perform 走共享干活路径，干完经
//      ctx.orchestrator.reportCodingResult 收执（落时间线 + await_human 暂停）。
import type { Context } from 'cordis'
import type { DelegatePayload } from 'space-orchestrator'

export const name = 'agent-coder-stub'
// cordis 严格注入：agents（报到）+ orchestrator（收执口）+ agentRuntime（干活）。
export const inject = ['agents', 'orchestrator', 'agentRuntime']

const AGENT_ID = 'agent.coder'
const TITLE = '编码者'

export function apply(ctx: Context) {
  // ── 报到（入驻 = 向 space-agent 缝注册；重复入驻即炸 —— 重启是新进程，无残留）──
  ctx.agents.register({
    id: AGENT_ID,
    kind: 'coding',
    title: TITLE,
    // 提示词引用（P8）：绑定 seed 预置的占位提示词；原文到位后 upsert 换正文，ref 不变。
    promptRef: 'prompt.coding',
    // capabilities 开放词表（seam 词汇）：stub 只声明 coding
    capabilities: ['coding'],
  })

  // ── 委托链：orchestrator 消费大脑委托后 emit，本 agent 认领 ─────────────
  ctx.on('orchestrator/delegate', (p: DelegatePayload) => {
    // 双口径认领（承 /tell 先例）：target = 名册 title 或 id。
    if (p.target !== TITLE && p.target !== AGENT_ID) return
    void ctx.agentRuntime
      .perform(AGENT_ID, p.instruction)
      .then((r) => {
        // 收执口：回执落时间线（authorKind='agent'）+ await_human 暂停。
        ctx.orchestrator.reportCodingResult(p.sessionId, p.target, r.receipt)
      })
      .catch((e: unknown) => {
        ctx.logger.error('[agent-coder-stub] 委托任务执行失败：%s', (e as Error).message)
      })
  })
}
