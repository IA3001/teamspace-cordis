// space-context —— 上下文注入层（分层 L4）实现：一次 LLM 调用的全部注入面。
//
// 语义（seam/space-context 契约照表执法）：
//   · 会话不存在 → ContextError('session_not_found')；promptRef 模板缺失
//     （ctx.prompts.get 抛 not_found）→ ContextError('prompt_missing')。
//   · system = persona 行（有则「你是：<persona>」）+ promptRef 模板正文 +
//     工具目录段（ctx.tools.list() 列「id — title」清单），join('\n\n')。
//   · history = Agent 可见事件尾部 recentLimit（缺省 20）条；人类专属工具活动不注入，
//     listBySession 本就按 seq 升序（seam 契约），切片保序。
//   · memories = memoryLimit>0 时 memory.recall(`session:<id>`, {limit})；
//     retrieval = query 非空时检索历史、会话/Agent 私有记忆与团队知识库。
//     两者失败都降级置空（注入面尽力而为，不因旁路数据源故障炸掉组装）。
//   · charBudget（缺省 12000）超限时**只裁 history**（从最旧开始），
//     system / memories / retrieval 不裁 —— 先保 system，再保旁路摘要，
//     最后裁 history（seam 类注释的裁剪顺序）。
//   · 组装是**纯读**：绝不产生写副作用。
import type { Context } from 'cordis'
import { ContextError, ContextAssemblyService } from 'space-context'
import type { AssembledContext, AssembleOptions } from 'space-context'
import type { MemoryItem } from 'space-memory'
import type { RetrievalHit } from 'space-retrieval'
import type { SessionEvent } from 'space-event'
import { isAgentVisibleEvent } from 'space-event'

export const name = 'space-context'
// 严格注入：session / eventLog / prompts / memory / retrieval + tools（工具目录段）。
export const inject = ['session', 'eventLog', 'prompts', 'memory', 'retrieval', 'tools']

/** 缺省值（与 seam/space-context 注释口径逐字一致）。 */
const DEFAULT_PROMPT_REF = 'prompt.minutes'
const DEFAULT_RECENT_LIMIT = 20
const DEFAULT_MEMORY_LIMIT = 5
const DEFAULT_CHAR_BUDGET = 12000
/** 检索注入的固定命中数（seam 注释口径：query 非空时 search limit 5）。 */
const RETRIEVAL_LIMIT = 5

export class ContextAssemblyServiceImpl extends ContextAssemblyService {
  async assemble(sessionId: string, opts: AssembleOptions = {}): Promise<AssembledContext> {
    // 1) 会话必须存在（其它都免谈）。
    if (!this.ctx.session.getSession(sessionId)) {
      throw new ContextError('session_not_found', `会话 ${sessionId} 不存在，无处组装上下文`)
    }
    const promptRef = opts.promptRef ?? DEFAULT_PROMPT_REF
    const recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT
    const memoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT
    const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET
    const selectedSources = opts.contextSources
      ? new Set(opts.contextSources)
      : new Set(['session', 'agent-memory', 'team-kb'])
    const includeSession = selectedSources.has('session')
    const includeAgentMemory = selectedSources.has('agent-memory') && Boolean(opts.agentId)
    const retrievalSources = [
      ...(includeSession ? ['event' as const] : []),
      ...(includeSession || includeAgentMemory ? ['memory' as const] : []),
      ...(selectedSources.has('team-kb') ? ['kb' as const] : []),
    ]

    // 2) system 段：persona 行 + prompt 模板正文 + 工具目录段。
    const parts: string[] = []
    if (opts.persona) {
      parts.push(`你是：${opts.persona}`)
    }
    // prompts.get 未知 ref → PromptError('not_found')；统一翻译成
    // ContextError('prompt_missing')（错误码只出自对应 seam，不自造）。
    let promptBody: string
    try {
      promptBody = this.ctx.prompts.get(promptRef).body
    } catch (e) {
      throw new ContextError(
        'prompt_missing',
        `提示词模板 ${promptRef} 缺失：${(e as Error)?.message ?? e}`,
      )
    }
    parts.push(promptBody)
    // 工具目录段：能力方注册进注册表的清单，给模型「有哪些工具可按名调用」。
    const tools = this.ctx.tools.list()
    if (tools.length > 0) {
      parts.push(`可用工具：\n${tools.map((t) => `${t.id} — ${t.title}`).join('\n')}`)
    }
    const system = parts.join('\n\n')

    // 3) history：尾部 recentLimit 条，listBySession 已按 seq 升序，切片保序。
    const allEvents: SessionEvent[] = includeSession
      ? this.ctx.eventLog.listBySession(sessionId).filter(isAgentVisibleEvent)
      : []
    let history = allEvents.slice(-recentLimit)

    // 4) memories：memoryLimit>0 才召回；失败置 []（尽力而为，不炸组装）。
    let memories: MemoryItem[] = []
    if (memoryLimit > 0 && (includeSession || includeAgentMemory)) {
      try {
        if (includeSession) memories = await this.ctx.memory.recall(`session:${sessionId}`, { limit: memoryLimit })
        if (includeAgentMemory && opts.agentId) {
          const privateMemories = await this.ctx.memory.recall(`agent:${opts.agentId}`, { limit: memoryLimit })
          memories = [...memories, ...privateMemories.filter((item) => !item.kind.startsWith('cursor:'))]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, memoryLimit * 2)
        }
      } catch (e) {
        console.warn(`[space-context] memory.recall 失败，记忆置空：${(e as Error)?.message ?? e}`)
        memories = []
      }
    }

    // 5) retrieval：query 非空才检索；失败置 []（同上，旁路降级）。
    let retrieval: RetrievalHit[] = []
    const query = opts.query?.trim()
    if (query && retrievalSources.length > 0) {
      try {
        retrieval = await this.ctx.retrieval.search(sessionId, query, {
          limit: RETRIEVAL_LIMIT,
          agentId: opts.agentId,
          sources: retrievalSources,
          memoryScopes: [
            ...(includeSession ? ['session' as const] : []),
            ...(includeAgentMemory ? ['agent' as const] : []),
          ],
        })
      } catch (e) {
        console.warn(`[space-context] retrieval.search 失败，检索置空：${(e as Error)?.message ?? e}`)
        retrieval = []
      }
    }

    // Recent memory recall and query-based memory RAG can overlap. Keep the
    // direct recent-memory injection authoritative and avoid repeating the same item.
    if (memories.length && retrieval.length) {
      const recalledIds = new Set(memories.map((item) => item.id))
      retrieval = retrieval.filter((hit) => hit.source !== 'memory' || !recalledIds.has(hit.id))
    }

    // 6) 字符预算：approxChars = system + history 正文长度；超 charBudget
    //    从 history 最旧（seq 升序的头部）开始裁，直到不超。memories /
    //    retrieval 不裁 —— system 优先，旁路摘要次之，history 最后。
    const systemChars = system.length
    const historyChars = (h: SessionEvent[]) => h.map((e) => e.text).join('').length
    let approxChars = systemChars + historyChars(history)
    while (approxChars > charBudget && history.length > 0) {
      history = history.slice(1) // 头部即最旧
      approxChars = systemChars + historyChars(history)
    }

    return { sessionId, system, history, memories, retrieval, approxChars }
  }
}

export function apply(ctx: Context) {
  // Service 基类构造即 provide（ctx.context，承 space-message 同款）。
  new ContextAssemblyServiceImpl(ctx)
}
