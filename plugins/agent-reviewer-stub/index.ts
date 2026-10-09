// agent-reviewer-stub —— 第三个 Coding Agent：代码审查者（P8 纯新增，2026-09-30）。
//
// 入驻形状（铁律 4：入驻 = 纯新增）——本包 + 自带 bundle 一行
//（packages/bundle/space-agent-reviewer-stub/），既有文件零改动；照
// agent-coder-stub（P8 收敛后）的模式抄：描述符 + 委托认领，仅四常量不同。
// 干活路径 = 共享机制 ctx.agentRuntime（领工作区 → 任务落盘 → 状态机 → 回执）。
import type { Context } from 'cordis'
import type { DelegatePayload } from 'space-orchestrator'

export const name = 'agent-reviewer-stub'
// messages：主动发言（IM 化改造 2026-09-30）。
export const inject = ['agents', 'orchestrator', 'agentRuntime', 'messages']

import z from 'schemastery'

/** 面板可配（5172 → 插件 → agent-reviewer-stub）：身份与提示词引用。 */
/** apply 侧的 TS 视图（值/类型同名双导出，TS 命名空间分离合法）。 */
export interface Config {
  agentId?: string
  title?: string
}

export const Config = z.object({
  agentId: z.string().description('注册表/入会用 id（改名需同步 users 表）').default('agent.reviewer'),
  title: z.string().description('给人看的名字（@ 提及候选与流程步骤名）').default('代码审查者'),
})


/** 从回执截一句主动总结（首行，截 80 字）。 */
function summaryOf(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim()
  return first.length > 80 ? `${first.slice(0, 80)}…` : first
}

export function apply(ctx: Context, config: Config = {}) {
  const AGENT_ID = config.agentId ?? 'agent.reviewer'
  const TITLE = config.title ?? '代码审查者'
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
      .then((r) => {
        // 收执口：回执落时间线；不再强制暂停（自治预算归引擎管，IM 化改造）。
        ctx.orchestrator.reportCodingResult(p.sessionId, p.target, r.receipt)
        // 主动发言：同一条 send 路径，void 防未处理 rejection。
        void ctx.messages.send(
          p.sessionId,
          AGENT_ID,
          `审查完成：${summaryOf(r.receipt) || summaryOf(p.instruction) || '（无摘要）'}。` +
            `需要我继续复查修改吗？@协调者 可继续派活`,
          [],
        ).catch((e: unknown) => console.error('[agent-reviewer-stub] 主动发言失败：', (e as Error).message))
      })
      .catch((e: unknown) => {
        console.error('[agent-reviewer-stub] 委托任务执行失败：', e)
      })
  })
}
