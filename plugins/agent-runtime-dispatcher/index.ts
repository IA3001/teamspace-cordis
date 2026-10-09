import type { Context } from 'cordis'
import type { DelegatePayload } from 'space-orchestrator'
import { AgentRunCancelledError } from 'space-agent-runtime'

export const name = 'agent-runtime-dispatcher'
export const inject = ['agentCatalog', 'agents', 'agentRuntime', 'orchestrator']

/** Execute team-created Agent definitions without adding a Cordis plugin per Agent. */
export function apply(ctx: Context) {
  ctx.on('orchestrator/delegate', (payload: DelegatePayload) => {
    const definition = ctx.agentCatalog.list().find((entry) =>
      entry.status === 'active' && (entry.id === payload.target || entry.title === payload.target),
    )
    if (!definition) return // Built-in plugin-backed Agents retain their own handlers.
    void ctx.agentRuntime.perform(definition.id, payload.instruction, {
      sessionId: payload.sessionId, sourceEventId: payload.eventId,
    })
      .then((result) => ctx.orchestrator.reportAgentResult(payload.sessionId, payload.target, result.receipt, result.sourceEventIds))
      .catch((error: unknown) => {
        if (error instanceof AgentRunCancelledError) {
          ctx.orchestrator.cancelDelegatedTask(payload.sessionId, payload.target, payload.eventId)
          ctx.logger.info('[agent-runtime-dispatcher] 已取消失效 Agent 任务（agent=%s, source=%s）', definition.id, payload.eventId)
          return
        }
        ctx.logger.error('[agent-runtime-dispatcher] Agent 执行失败（%s）：%s', definition.id, (error as Error).message)
        try {
          ctx.orchestrator.reportAgentResult(
            payload.sessionId,
            payload.target,
            `【执行失败】${definition.title} 未能完成任务：${(error as Error).message}`,
          )
        } catch (reportError) {
          ctx.logger.error('[agent-runtime-dispatcher] 失败状态无法回报（%s）：%s',
            definition.id, (reportError as Error).message)
        }
      })
  })
}
