// ai-summary —— /summary 指令：一键让会议记录官生成本会话纪要（2026-10-01）。
//
// 全分层组合（承 agent-analyst-llm 示范）：L4 上下文注入层组装
//（prompt.minutes + 最近 60 条历史）→ L0 模型层单次调用 → L8 协作层发言
//（以 a_recorder 身份上时间线，落库 + 广播，所有人可见）。
// 诚实标注铁律：LLM 未配置 / 调用失败一律回【占位】文案，不猜不重试。
//
// 指令路径（非委托路径）：staging-commands 的入站路由会把行首 '/' 的输入
// dispatch 到本指令；/help 由 commands.list() 动态生成，注册即出现在清单。
import type { Context } from 'cordis'

export const name = 'ai-summary'
export const inject = ['commands', 'context', 'llm', 'messages', 'session', 'eventLog']

export const apply = (ctx: Context) => {
  const AGENT_ID = 'a_recorder'
  const ROLE = '会议记录官'

  ctx.commands.register({
    name: 'summary',
    usage: '/summary —— 让会议记录官生成本会话纪要（真模型）',
    minArgs: 0,
    maxArgs: 0,
    run: async (c) => {
      // ── L4 上下文注入层：注入面只有一份（prompt.minutes + 最近 60 条）。──
      // 组装失败（如 prompt_missing）不致命 —— 降级为最小 system + 手拼尾部
      // 60 条历史（照 agent-analyst-llm 的降级惯例）。
      let system: string
      try {
        const assembled = await ctx.context.assemble(c.sessionId, {
          promptRef: 'prompt.minutes',
          persona: '会议记录官',
          recentLimit: 60,
        })
        system = assembled.system
      } catch (e) {
        const tail = ctx.eventLog
          .listBySession(c.sessionId)
          .slice(-60)
          .map((ev) => `${ev.authorId}: ${ev.text}`)
          .join('\n')
        system = `你是「${ROLE}」。以下是会话 ${c.sessionId} 的最近会议内容：\n${tail}`
        console.warn(`[ai-summary] L4 组装降级（${(e as Error).message}），用最小 system 继续`)
      }

      // ── L0 模型层：单次调用，不重试不猜；未配置 → 占位诚实标注。──
      if (!ctx.llm.configured) {
        return { text: '【占位】真模型未配置（.env 缺 LLM 三件套），无法生成纪要。' }
      }

      let text: string
      try {
        text = await ctx.llm.chat([
          {
            role: 'system',
            content:
              system +
              '\n你是会议记录官：把上面的会议内容整理成简明纪要（要点列表，≤15 条，末尾给一行「下一步建议」）。',
          },
          // 最近内容已在 system 组装里，user 消息只作触发。
          { role: 'user', content: '请生成纪要' },
        ])
      } catch (e) {
        const msg = (e as Error).message
        console.warn(`[ai-summary] LLM 调用失败：${msg}`)
        return { text: `【占位】纪要生成失败：${msg}` }
      }

      // ── L8 协作层发言：以 a_recorder 身份上时间线（落库 + 广播）。──
      // a_recorder 必须在会话名册（默认名册含它）；不在则先 join（幂等承旧
      // 语义），否则 messages.send 会因 not_member 失败。
      const inRoster = ctx.session.listMembers(c.sessionId).some((m) => m.principalId === AGENT_ID)
      if (!inRoster) {
        ctx.session.join({ sessionId: c.sessionId, principalId: AGENT_ID, role: ROLE })
      }
      void ctx.messages.send(c.sessionId, AGENT_ID, `【纪要·真模型】\n${text}`, [])
      return { text: '纪要已生成并上屏（见时间线）。' }
    },
  })

  console.log(`[${name}] 就绪：/summary 指令已注册（发言身份 ${AGENT_ID}）`)
}
