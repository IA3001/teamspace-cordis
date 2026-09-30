// agent-reviewer-stub —— 第三个 Coding Agent：代码审查者（P8 纯新增，2026-09-30）。
//
// 入驻形状（铁律 4：入驻 = 纯新增）——本包 + 自带 bundle 一行
//（packages/bundle/space-agent-reviewer-stub/），既有文件零改动；照
// agent-coder-stub（P8 收敛后）的模式抄：描述符 + 委托认领，仅四常量不同。
// 干活路径 = 共享机制 ctx.agentRuntime（领工作区 → 任务落盘 → 状态机 → 回执）。
import type { Context } from 'cordis'
import type { DelegatePayload } from 'space-orchestrator'

export const name = 'agent-reviewer-stub'
export const inject = ['agents', 'orchestrator', 'agentRuntime']

const AGENT_ID = 'agent.reviewer'
const TITLE = '代码审查者'

export function apply(ctx: Context) {
  ctx.agents.register({
    id: AGENT_ID,
    kind: 'coding',
    title: TITLE,
    // 提示词引用（P8）：绑定 seed 预置的占位提示词（角色4 代码审查）。
    promptRef: 'prompt.review',
    capabilities: ['review'],
  })

  ctx.on('orchestrator/delegate', (p: DelegatePayload) => {
    if (p.target !== TITLE && p.target !== AGENT_ID) return
    void ctx.agentRuntime
      .perform(AGENT_ID, p.instruction)
      .then((r) => ctx.orchestrator.reportCodingResult(p.sessionId, p.target, r.receipt))
      .catch((e: unknown) => {
        ctx.logger.error('[agent-reviewer-stub] 委托任务执行失败：%s', (e as Error).message)
      })
  })
}
