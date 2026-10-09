// memory-recorder —— 记忆自动沉淀观察者（2026-10-01，体验补全）。
//
// 订阅内核事件 'orchestrator/pause'：回合以 completed（自然完成）收束时，
// 把本回合的收束摘要写进记忆层（ctx.memory，scope = session:<id>）——
// 下一次任何人 @ 协调者/agent 时，L4 上下文注入层会把记忆召回进 system，
// AI 因此「记得上次聊到哪」。预算耗尽（budget_exhausted）等暂停不沉淀
// （未完成的工作不配叫结论）。
//
// 设计为独立观察者插件（横切），不改 orchestrator —— 流转层保持零记忆职责，
// 分层章程反模式 3（流转层只调度不干活）的对称面：流转层也不记账。
import type { Context } from 'cordis'

export const name = 'memory-recorder'
export const inject = ['memory']

export function apply(ctx: Context) {
  ctx.on('orchestrator/pause', ({ sessionId, stopReason, stopDetail }) => {
    if (stopReason !== 'completed' || !stopDetail.trim()) return
    void ctx.memory
      .remember(
        `session:${sessionId}`,
        'summary',
        `回合收束：${stopDetail}`,
        { weight: 0.6, authorId: 'a_coordinator' },
      )
      .catch((e: unknown) => {
        // 沉淀失败不阻塞主流程（只 warn 留痕，铁律 2）。
        console.warn(`[memory-recorder] 会话 ${sessionId} 记忆沉淀失败：${(e as Error).message}`)
      })
  })
  console.log(`[${name}] 就绪：orchestrator/pause(completed) → memory.remember(session:<id>)`)
}
