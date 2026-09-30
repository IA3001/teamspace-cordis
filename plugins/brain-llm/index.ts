// brain-llm —— 协调者大脑的**真 LLM 实现**（P8 下半场，2026-09-30）。
//
// 定位（用户拍板：本轮只给 coding 链接真 LLM）：LLM_API_KEY 等三件套齐时
// 由本包注册大脑 —— 决策交给模型（NLP 判定授权），原始输出原样交给引擎的
// 三级兜底解析（policy/space-authz，**零改动**）；调用失败抛 LlmError →
// 引擎走既有 coordinator_error 暂停路径（不猜、不重试）。
//
// 与 brain-stub 互斥（确定性选择，铁律：两包永远至多注册一个大脑）：
//   .env 三件套齐（LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）→ 本包注册、stub 让位；
//   不齐 → 本包不注册、stub 上线。谓词与 stub 内 llmReady() 同源（同一批
//   space-llm 环境变量常量），启动日志明示当前大脑（5172 日志页可见）。
//   本包 config.enabled=false → 无大脑（coordinator_unconfigured 安全默认）。
//
// 协调者系统提示（JSON 输出契约 + 授权名单 + 护栏语义）：先以常量驻本包
//（记账：prompt-store 化可后续做 —— 待定 10 的 4 角色原文到位后一并考虑）。
// key 绝不入日志（只打 base/model 是否就绪）。
import type { Context } from 'cordis'
import type { OrchestratorBrain, PlanRequest } from 'space-orchestrator'

export const name = 'brain-llm'
// cordis 严格注入：orchestrator（registerBrain）+ llm（补全能力）。
export const inject = ['orchestrator', 'llm']

export interface Config {
  /** 真大脑开关（false = 不注册，回 coordinator_unconfigured 安全默认）。 */
  enabled?: boolean
}

/**
 * 协调者系统提示。$TARGETS 由每次请求的授权名单替换。
 * 契约与 policy/space-authz 的解析形状逐字对齐（reply/reason/delegate），
 * 护栏语义承旧口径（负面不委托、多目标不委托、不确定只回复）。
 */
const SYSTEM_PROMPT = `你是「团队空间」多智能体协作系统的协调者大脑。
你只输出一个 JSON 对象，禁止输出 JSON 以外的任何文字。形状：
{"reply":"给人类的回复","reason":"一句话理由","delegate":{"target":"目标","instruction":"任务"} 或 null}
规则：
1. target 必须逐字取自授权名单：[$TARGETS]。名单外目标会被引擎拒绝并暂停。
2. 仅当人类发言明确授权某个目标行动时 delegate 才非空；否则 delegate 必须为 null，用 reply 商议。
3. instruction 是交给目标的任务描述；人类未细化时用人类原话。
4. 人类语气负面或要求先讨论（不必/不要/先讨论/只商议等）→ 不委托，只在 reply 回应。
5. 不确定时宁可只回复，不要猜目标。`

export function apply(ctx: Context, config: Config = {}) {
  if (config.enabled === false) {
    ctx.logger.warn('[brain-llm] 已由配置停用（enabled=false）—— 协调者保持 coordinator_unconfigured，等待人类指示')
    return
  }
  // 选择谓词与 brain-stub 的 llmReady() 同源（三件套齐 = 就绪）。
  if (!ctx.llm.configured) {
    ctx.logger.info('[brain-llm] LLM 三件套未齐 —— 本包不注册大脑（确定性选择：无 key 则 brain-stub）')
    return
  }
  ctx.logger.info(
    '[brain-llm] 大脑上线（真 LLM）：base=%s model=%s（key 已加载，绝不落日志）—— 决策交模型，原始输出走既有三级兜底',
    process.env.LLM_BASE_URL ?? '(unset)',
    process.env.LLM_MODEL ?? '(unset)',
  )

  const brain: OrchestratorBrain = {
    async plan(req: PlanRequest): Promise<string> {
      // 用户消息：人类原话 + @ 提示（仅供参考）+ 本回合授权名单。
      const user =
        `人类发言：${req.humanText}\n` +
        `@ 提及提示：${req.mentionHints.join('、') || '无'}（仅供参考，以自然语言为准）\n` +
        `当前授权名单：${req.targets.join('、') || '（空）'}`
      // 单次调用（不重试）；返回**原始文本** —— 可能是合法 JSON / 坏 JSON /
      // 纯文本，三级兜底在 policy/space-authz 里对它解析（P3 拍板口径）。
      return ctx.llm.chat([
        { role: 'system', content: SYSTEM_PROMPT.replaceAll('$TARGETS', req.targets.join('、') || '（空）') },
        { role: 'user', content: user },
      ])
    },
  }
  ctx.orchestrator.registerBrain(brain)
}
