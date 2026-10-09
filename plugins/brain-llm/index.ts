// brain-llm —— 协调者大脑的**真 LLM 实现**（P8 下半场，2026-09-30）。
//
// 定位：文字模型 API 配置就绪时
// 由本包注册大脑 —— 决策交给模型（NLP 判定授权），原始输出原样交给引擎的
// 三级兜底解析（policy/space-authz，**零改动**）；调用失败抛 LlmError →
// 引擎走既有 coordinator_error 暂停路径（不猜、不重试）。
//
// 与 brain-stub 互斥（确定性选择，铁律：两包永远至多注册一个大脑）：
//   ctx.llm.configured 同时检查后台 settings、插件配置与 .env 回退；已配置时
//   本包注册、stub 让位；未配置时本包不注册、stub 上线。日志只显示地址和
//   模型 ID，不记录 API 凭据。
//   本包 config.enabled=false → 无大脑（coordinator_unconfigured 安全默认）。
//
// 协调者系统提示（JSON 输出契约 + 授权名单 + 护栏语义）：先以常量驻本包
//（记账：prompt-store 化可后续做 —— 待定 10 的 4 角色原文到位后一并考虑）。
// 上下文注入（P9，2026-10-01）：plan 前优先经 ctx.context.assemble 组装
//（L4 就绪走 L4），组装抛错（prompt_missing / session_not_found 等）时回退
// 本包常量手拼 —— 注入逻辑一份缝、一份兜底，见 plan 内注释。
// key 绝不入日志（只打 base/model 是否就绪）。
import type { Context } from 'cordis'
import type { OrchestratorBrain, PlanRequest } from 'space-orchestrator'

export const name = 'brain-llm'
// cordis 严格注入：orchestrator（registerBrain）+ llm（补全能力）+ context（L4 上下文组装）。
export const inject = ['orchestrator', 'llm', 'context', 'settings']

export interface Config {
  /** 真大脑开关（false = 不注册，回 coordinator_unconfigured 安全默认）。 */
  enabled?: boolean
}

/**
 * 协调者输出契约（大脑职责词汇，不随 prompt.minutes 模板走 —— 模板是
 * 共享资产，JSON 形状与授权护栏只有协调者大脑需要）。$TARGETS 由每次请求
 * 的授权名单替换。契约与 policy/space-authz 的解析形状逐字对齐
 *（reply/reason/delegate），护栏语义承旧口径（负面不委托、多目标不委托、
 * 不确定只回复）。
 */
const OUTPUT_CONTRACT = `输出契约（必须遵守）：
你只输出一个 JSON 对象，禁止输出 JSON 以外的任何文字。形状：
{"reply":"给人类的回复","reason":"一句话理由","delegate":{"target":"目标","instruction":"任务"} 或 null}
规则：
1. target 必须逐字取自授权名单：[$TARGETS]。名单外目标会被引擎拒绝并暂停。
2. 人类用 @ 点名了授权名单中的某个目标 = **明确授权** —— 必须 delegate 那个目标。
   此时你是调度员不是专家：reply 只允许简短确认（≤20 字，如「好的，交由需求分析师」），
   **绝不允许在 reply 里替目标完成任务**（人类点的是那位专家，不是你）。
   只有当人类没有 @ 任何人、或语气负面/要求先讨论时，才 delegate 为 null 用 reply 商议。
3. instruction 是交给目标的任务描述；人类未细化时用人类原话。
4. 人类语气负面或要求先讨论（不必/不要/先讨论/只商议等）→ 不委托，只在 reply 回应。
5. 不确定时宁可只回复，不要猜目标。
6. 若「人类发言」其实是某位 Agent 的成果/发言回流（内容是任务答案而非新指令）：
   工作已完成时 delegate 必须为 null 且 reply 必须是空字符串 \"\"——成果已在
   时间线上，任何人复述都是噪音。只有当你判断还差明确的下一步时才继续委托。`

/** 回退手拼 system 的开场白（L4 未就绪时的最小身份段）。 */
const FALLBACK_PREAMBLE = `你是「团队空间」多智能体协作系统的协调者大脑。`

export function apply(ctx: Context, config: Config = {}) {
  if (config.enabled === false) {
    ctx.logger.warn('[brain-llm] 已由配置停用（enabled=false）—— 协调者保持 coordinator_unconfigured，等待人类指示')
    return
  }
  // 与 brain-stub 共用同一个 configured 谓词，确保任何配置来源都只选择一个大脑。
  if (!ctx.llm.configured) {
    ctx.logger.info('[brain-llm] 文字模型尚未配置 —— 本包不注册大脑（占位大脑保持启用）')
    return
  }
  const shownBase = ctx.settings.get<string>('llm.baseURL', '')?.trim() || process.env.LLM_BASE_URL || '(unset)'
  const shownModel = ctx.settings.get<string>('llm.model', '')?.trim() || process.env.LLM_MODEL || '(unset)'
  ctx.logger.info(
    '[brain-llm] 大脑上线（真 LLM）：base=%s model=%s（key 已加载，绝不落日志）—— 决策交模型，原始输出走既有三级兜底',
    shownBase, shownModel,
  )

  const brain: OrchestratorBrain = {
    async plan(req: PlanRequest): Promise<string> {
      // 本回合授权名单（system 契约与 user 尾行共用）。
      const targets = req.targets.join('、') || '（空）'
      // 用户消息：人类原话 + @ 提示（仅供参考）+ 本回合授权名单。
      const user =
        `人类发言：${req.humanText}\n` +
        `@ 提及提示：${req.mentionHints.join('、') || '无'}（仅供参考，以自然语言为准）\n` +
        `当前授权名单：${targets}`

      // L4 就绪走 L4，未就绪回退：优先经 ctx.context.assemble 统一组装
      //（prompt.minutes 模板 + 工具目录 + 最近历史 + 记忆召回 + 检索命中，
      // 已裁到字符预算内）；组装抛错（prompt_missing / session_not_found 等）
      // 回退到本包常量手拼。assemble 是纯本地读、只调一次，不是 LLM 重试
      // —— 不违「不猜不重试」铁律；LLM 依旧只有下方那一次调用。
      let system = `${FALLBACK_PREAMBLE}\n${OUTPUT_CONTRACT.replaceAll('$TARGETS', targets)}`
      let userContent = user
      try {
        const assembled = await ctx.context.assemble(req.sessionId, {
          promptRef: 'prompt.minutes',
          // 检索 query：本轮人类消息截 200 字（防止超长发言撑爆检索层）。
          query: req.humanText.slice(0, 200),
        })
        // system = 组装产物（身份/模板/工具目录）+ 协调者输出契约（职责词汇，
        // 模板不携带；缺了它三级兜底解析不到 JSON，大脑必炸 coordinator_error）。
        system = `${assembled.system}\n\n${OUTPUT_CONTRACT.replaceAll('$TARGETS', targets)}`
        // user 侧上下文：最近历史尾部 10 条（组装产物已按 seq 升序）拼在
        // 原本的人类发言/授权名单之前 —— 授权口径行必须保持在末尾。
        const recent = assembled.history
          .slice(-10)
          .map((e) => `[seq ${e.seq}] ${e.authorKind}${e.authorId ? ` ${e.authorId}` : ''}：${e.text}`)
          .join('\n')
        userContent = (recent ? `最近对话（供参考，按时间升序）：\n${recent}\n\n` : '') + user
      } catch (e) {
        ctx.logger.warn(
          '[brain-llm] ctx.context.assemble 失败（%s）—— L4 未就绪，回退手拼 system',
          (e as Error)?.message ?? e,
        )
      }

      // 单次调用（不重试）；返回**原始文本** —— 可能是合法 JSON / 坏 JSON /
      // 纯文本，三级兜底在 policy/space-authz 里对它解析（P3 拍板口径）。
      const raw = await ctx.llm.chat([
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ])
      // 诊断（2026-10-05）：大脑原始输出落日志页（logs.db）—— 不含 key，
      // 只含模型决策原文；排「大脑答非所问」类问题必须看得到它。
      ctx.logger.info('[brain-llm] 原始输出：%s', raw.slice(0, 500))
      return raw
    },
  }
  ctx.orchestrator.registerBrain(brain)
}
