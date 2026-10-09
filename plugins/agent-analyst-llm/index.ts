// agent-analyst-llm —— 第一个「真模型会议 Agent」（分层架构全组合示范，2026-09-30）。
//
// 分层旅程（docs/ARCHITECTURE.md 第四节）：被 L7 流转层委托 → L4 上下文注入层
// 组装（prompt 模板 + 最近历史 + 记忆 + 检索）→ L0 模型层单次调用 → L8 协作层
// 发言（落时间线 + 广播）。LLM 未配置 / 调用失败时回退【占位】消息，诚实标注
// （铁律：不猜不重试；占位与真模型处处可辨）。
//
// 铁律 4 落地：加一个会议 bot = 复制本插件 + 清单一行改 config（role/agentId/title），
// 零改动现有文件。config 示例（bundle patch）：
//   { id: agent-analyst-llm, name: './plugins/agent-analyst-llm/index.ts',
//     config: { role: '需求分析师', agentId: 'a_analyst', title: '需求分析师', promptRef: 'prompt.minutes' } }
import type { Context } from 'cordis'
import { AgentRunCancelledError } from 'space-agent-runtime'
import z from 'schemastery'
import type { DelegatePayload } from 'space-orchestrator'
import { formatCitedAnswer } from 'space-retrieval'
import type { RetrievalHit } from 'space-retrieval'

export const name = 'agent-analyst-llm'
// settings：/agents 页 per-agent promptRef 重定向（agent.<id>.promptRef）。
export const inject = ['agents', 'session', 'eventLog', 'messages', 'context', 'llm', 'orchestrator', 'settings', 'agentRuntime']

/**
 * 配置面板 schema（5172 自动渲染）：加一个会议 bot = 复制 bundle 一行改这四个字段。
 */
export const Config = z.object({
  role: z.string().description('会议角色（与 session_members.role 词汇一致；授权名单按角色合并）').default('需求分析师'),
  agentId: z.string().description('注册表与发言用 id（users 表内建的 a_* 身份）').default('a_analyst'),
  title: z.string().description('给人看的名字（@ 提及候选）').default('需求分析师'),
  promptRef: z.string().description('提示词模板引用（seed 预置：prompt.minutes 等）').default('prompt.minutes'),
})

/** 运行时取值形状（兼容旧取值：全部可选，缺省回到底部四个常量）。 */
export interface Config {
  role?: string
  agentId?: string
  title?: string
  promptRef?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const ROLE = config.role ?? '需求分析师'
  const AGENT_ID = config.agentId ?? 'a_analyst'
  const TITLE = config.title ?? ROLE
  const PROMPT_REF = config.promptRef ?? 'prompt.minutes'

  // 入驻注册表（L6 Agent 层）：meeting kind，@ 提及候选即生成。
  ctx.agents.register({
    id: AGENT_ID,
    kind: 'meeting',
    title: TITLE,
    promptRef: PROMPT_REF,
    speechPolicy: 'proactive',
    capabilities: ['analysis'],
  })

  ctx.on('orchestrator/delegate', (p: DelegatePayload) => {
    // 双口径认领（承 coder-stub 先例）：target = 名册 title 或 id。
    if (p.target !== TITLE && p.target !== AGENT_ID) return

    const controller = new AbortController()
    let finish!: () => void
    const settled = new Promise<void>((resolve) => { finish = resolve })
    const unregister = ctx.agentRuntime.registerSourceRun(p.eventId, () => controller.abort(), settled)
    void (async () => {
      try {
      // L4 上下文注入层：注入面只有一份（prompt + 历史 + 记忆 + 检索）。
      // 组装失败（如 prompt_missing）不致命 —— 降级为最小 system 继续。
      let system = `你是「${TITLE}」（会议角色：${ROLE}）。基于会议上下文履行职责，回答简洁、给结论与依据。`
      let query = p.instruction.slice(0, 200)
      const sourceEventIds = new Set<string>()
      let retrievalHits: RetrievalHit[] = []
      // promptRef 现算：/agents 页的 per-agent 重定向（agent.<id>.promptRef）
      // 优先，未设置回退启动 Config。改完即生效，无需重启。
      const ref = ctx.settings.get<string>(`agent.${AGENT_ID}.promptRef`, '') || PROMPT_REF
      try {
        const assembled = await ctx.context.assemble(p.sessionId, {
          promptRef: ref,
          query,
          persona: `${TITLE}（${ROLE}）`,
          recentLimit: 20,
          memoryLimit: 5,
          agentId: AGENT_ID,
        })
        system = assembled.system
        for (const event of assembled.history) {
          if (event.kind !== 'message' || event.voided) continue
          sourceEventIds.add(event.id)
          for (const id of event.sourceEventIds ?? []) sourceEventIds.add(id)
        }
        for (const item of assembled.memories) for (const id of item.sourceEventIds ?? []) sourceEventIds.add(id)
        retrievalHits = assembled.retrieval
        for (const hit of retrievalHits) {
          if (hit.source === 'event') sourceEventIds.add(hit.id)
          for (const id of hit.sourceEventIds ?? []) sourceEventIds.add(id)
        }
        if (assembled.memories.length) {
          system += `\n\nAgent 与会话记忆（含来源事件）：\n${assembled.memories.map((item) =>
            `- [${item.sourceEventIds?.join(',') || item.sourceEventId || 'session-memory'}] ${item.text}`,
          ).join('\n')}`
        }
        if (assembled.retrieval.length) {
          system += `\n\n检索材料（只能引用下列来源 ID）：\n${assembled.retrieval.map((hit) =>
            `- 【来源:${hit.source}:${hit.id}】${hit.title ?? hit.source}：${hit.text}`,
          ).join('\n')}`
          system += '\n引用规则：基于检索材料的事实性结论须在相邻句末使用精确格式【来源:类型:ID】；只能使用上方列出的类型和 ID，不得编造引用。'
        }
        const priorMessages = assembled.history
          .filter((event) => event.kind === 'message' && !event.voided)
          .map((event) => `${event.authorKind === 'agent' ? 'Agent' : event.authorKind === 'human' ? '成员' : '系统'}：${event.text}`)
          .join('\n')
        if (priorMessages) query = `会话历史：\n${priorMessages}\n\n当前任务：${query}`
      } catch (e) {
        console.warn(`[agent-analyst-llm] L4 组装降级（${(e as Error).message}），用最小 system 继续`)
      }

      // L0 模型层：单次调用，不重试不猜。
      if (controller.signal.aborted) throw new AgentRunCancelledError(p.eventId)
      if (!ctx.llm.configured) {
        ctx.orchestrator.reportFeedback(
          p.sessionId, TITLE,
          `【占位】「${TITLE}」收到委托：${p.instruction.slice(0, 80)}。真模型未配置，先留痕待命。`,
          [...sourceEventIds],
        )
        return
      }

      try {
        const text = await ctx.llm.chat([
          { role: 'system', content: system },
          { role: 'user', content: `会议委托：${p.instruction}\n请以「${TITLE}」的职责给出回应。` },
        ], { signal: controller.signal })
        if (controller.signal.aborted) throw new AgentRunCancelledError(p.eventId)
        // L8 协作层发言：与人类消息同一条 send 路径（落事件 + 广播），
        // 发言回流（space/event-appended）由 L7 流转层决定是否续步。
        // 单次落库（2026-10-05）：成果只经 reportFeedback 落一条事件 ——
        // 此前 messages.send + reportFeedback 各落一条，时间线同文重复。
        ctx.orchestrator.reportFeedback(p.sessionId, TITLE,
          `【真模型】${formatCitedAnswer(text || '（空输出）', retrievalHits)}`, [...sourceEventIds])
      } catch (e) {
        if (controller.signal.aborted || e instanceof AgentRunCancelledError) {
          ctx.orchestrator.cancelDelegatedTask(p.sessionId, p.target, p.eventId)
          return
        }
        const msg = (e as Error).message
        console.warn(`[agent-analyst-llm] LLM 调用失败：${msg}`)
        ctx.orchestrator.reportFeedback(
          p.sessionId, TITLE, `【占位】「${TITLE}」调用真模型失败（${msg}），本轮以占位留痕。`,
          [...sourceEventIds],
        )
      }
      } catch (error) {
        if (controller.signal.aborted || error instanceof AgentRunCancelledError) {
          ctx.orchestrator.cancelDelegatedTask(p.sessionId, p.target, p.eventId)
          return
        }
        ctx.logger.error('[agent-analyst-llm] 委托任务失败（source=%s）：%s', p.eventId, (error as Error).message)
        try {
          ctx.orchestrator.reportFeedback(p.sessionId, TITLE,
            `【执行失败】「${TITLE}」任务失败：${(error as Error).message}`)
        } catch { /* withdrawn delegation or recorder already cleared */ }
      } finally {
        unregister()
        finish()
      }
    })()
  })

  console.log(`[${name}] 就绪：${TITLE}（${AGENT_ID}，role=${ROLE}，promptRef=${PROMPT_REF}）`)
}
