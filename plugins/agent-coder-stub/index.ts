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
// cordis 严格注入：agents（报到）+ orchestrator（收执口）+ agentRuntime（干活）
// + messages（主动发言，IM 化改造 2026-09-30）。
export const inject = ['agents', 'orchestrator', 'agentRuntime', 'messages']

import z from 'schemastery'

/** 面板可配（5172 → 插件 → agent-coder-stub）：身份与提示词引用。 */
/** apply 侧的 TS 视图（值/类型同名双导出，TS 命名空间分离合法）。 */
export interface Config {
  agentId?: string
  title?: string
}

export const Config = z.object({
  agentId: z.string().description('注册表/入会用 id（改名需同步 users 表）').default('agent.coder'),
  title: z.string().description('给人看的名字（@ 提及候选与流程步骤名）').default('编码者'),
})


/** 从回执截一句主动总结（首行，截 80 字）。 */
function summaryOf(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim()
  return first.length > 80 ? `${first.slice(0, 80)}…` : first
}

export function apply(ctx: Context, config: Config = {}) {
  const AGENT_ID = config.agentId ?? 'agent.coder'
  const TITLE = config.title ?? '编码者'
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
        // 收执口：回执落时间线（authorKind='agent'）。IM 化改造后不再强制
        // await_human —— 由编排引擎按自治预算决定是否继续。
        ctx.orchestrator.reportCodingResult(p.sessionId, p.target, r.receipt)
        // 主动发言（IM 化改造，2026-09-30）：与人类消息同一条 send 路径
        // （落事件+广播），void 前缀防未处理 rejection。
        void ctx.messages.send(
          p.sessionId,
          AGENT_ID,
          `编码完成：${summaryOf(r.receipt) || summaryOf(p.instruction) || '（无摘要）'}。` +
            `需要我继续验证或补充实现吗？@协调者 可继续派活`,
          [],
        ).catch((e: unknown) => console.error('[agent-coder-stub] 主动发言失败：', (e as Error).message))
      })
      .catch((e: unknown) => {
        console.error('[agent-coder-stub] 委托任务执行失败：', e)
        console.error('[agent-coder-stub] 委托任务执行失败：', e)
      })
  })
}
