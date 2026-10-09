// brain-stub —— 协调者大脑的**占位实现**（P8，2026-09-30）。
//
// 本包是占位大脑，让未配置文字模型时委托回路仍可端到端观测；它**不是 NLP**
// —— 决策规则是显式占位：
//   分支一（命中）：mentionHints（@ 提示 id）能对上授权 target（会议成员
//     id → 角色；coding 名册 id → title，由引擎给定的 targets 裁决）→
//     返回**合法 JSON** 委托（instruction = 人类原话；兜底 0 层直接采用）；
//   分支二（未命中）：纯文本回复（兜底 1 层路径：只回复、不委托、暂停）。
// 文案处处明示「占位」标记（2026-09-30 拍板瘦身：原「占位大脑（非 NLP，等待
// 模型 key）」长前缀缩为【占位】，诚实语义保留 —— 委托分支句内仍带「非 NLP
// 判定」）—— 时间线与右栏能一眼
// 分辨这不是真模型（铁律 2：看见的是真实状态）。
// 真大脑由 plugins/brain-llm 提供。本包与它互斥：按 ctx.llm.configured
// 选择；该状态统一涵盖后台 settings、插件配置和 .env 回退，避免两处判断漂移。
//
// config（组合根可覆盖）：enabled=false → 不注册大脑，orchestrator 回到
// coordinator_unconfigured 安全默认（与 P3「未配置大脑」行为一致）。
//
// ⚠ BRAIN_SABOTAGE=1（verify-p8 红测探针，断言 ⑬）：改坏分支二的决策形状
// —— 未命中也吐委托 JSON；断言「未命中不委托」必须判红；还原（不设 env）复绿。
import type { Context } from 'cordis'
import z from 'schemastery'
import type { OrchestratorBrain, PlanRequest } from 'space-orchestrator'

export const name = 'brain-stub'
// cordis 严格注入：orchestrator（registerBrain）+ session（成员 id→角色）+
// agents（coding 名册 id→title）。
export const inject = ['orchestrator', 'session', 'agents', 'llm']

/** 配置面板 schema（5172 自动渲染）：占位大脑开关。 */
export const Config = z.object({
  enabled: z.boolean()
    .description('占位大脑开关（false = 不注册大脑，协调者回到 coordinator_unconfigured 安全默认）')
    .default(true),
})

/** 运行时取值形状（兼容旧取值：可选，缺省启用）。 */
export interface Config {
  /** 占位大脑开关（false = 不注册大脑，回到 coordinator_unconfigured 安全默认）。 */
  enabled?: boolean
}

const MARK = '占位'

export function apply(ctx: Context, config: Config = {}) {
  if (config.enabled === false) {
    ctx.logger.warn('[brain-stub] 已由配置停用（enabled=false）—— 协调者保持 coordinator_unconfigured，等待人类指示')
    return
  }
  // 两种实现共用 ctx.llm.configured：后台设置、插件配置和环境变量均走同一
  // 优先级；已配置让位给真模型，未配置才启动占位实现。
  if (ctx.llm.configured) {
    ctx.logger.info('[brain-stub] 文字模型已配置（后台/API 设置或环境变量）—— 占位大脑让位，由 brain-llm 提供')
    return
  }
  ctx.logger.info('[brain-stub] 占位大脑上线（文字模型尚未配置）—— 回复/回执均诚实标注占位；保存 API 配置后由 brain-llm 接管')

  /**
   * hint（@ 提示 id）→ 授权名单里的 target；对不上返回 null。
   * 解析双来源：会话成员 id → 角色（会议机器人）；coding 名册 id → title。
   * 名单裁决仍归引擎（isAuthorizedTarget）—— 大脑只转述提示。
   */
  function resolveHint(req: PlanRequest, hint: string): string | null {
    // 顺序刻意先名册后成员：P8 起 coding agent 也会以本 id 入会（role=成员），
    // 成员查找对它只会返回「成员」，会掩盖名册 title —— 名册优先才拿得到
    // 授权名单里的「编码者」等 title；会议机器人不在名册，自然落到成员查找。
    try {
      const a = ctx.agents.list('coding').find((x) => x.descriptor.id === hint)
      if (a) return a.descriptor.title
    } catch { /* agents 服务缺席：跳过名册来源 */ }
    try {
      const m = ctx.session.listMembers(req.sessionId, true).find((x) => x.principalId === hint)
      if (m) return m.role
    } catch { /* session 服务缺席（裸 harness）：跳过成员来源 */ }
    return null
  }

  const brain: OrchestratorBrain = {
    async plan(req: PlanRequest): Promise<string> {
      // 分支一（命中）：@ 提示对上授权 target → 合法 JSON 委托，instruction = 人类原话。
      for (const hint of req.mentionHints) {
        const target = resolveHint(req, hint)
        if (target && req.targets.includes(target)) {
          return JSON.stringify({
            reply: `【${MARK}】检测到 @${hint}（${target}），按名册直接委托（非 NLP 判定）。`,
            reason: '占位大脑：@ 提示命中授权名册',
            delegate: { target, instruction: req.humanText },
          })
        }
      }
      // 分支二（未命中）：纯文本只回复。刻意**不嵌人类原话**（防三级兜底的
      // 「将转达」层把回执误判成委托），也刻意避开负面词表与委托话术（不惊动护栏）。
      if (process.env.BRAIN_SABOTAGE === '1') {
        // 红测探针：未命中也委托 —— 决策形状改坏，verify-p8 分支二必红。
        return JSON.stringify({
          reply: `【${MARK}】（SABOTAGE）未命中也委托`,
          reason: 'sabotage：改坏分支二',
          delegate: { target: req.targets[0] ?? '', instruction: req.humanText },
        })
      }
      return `【${MARK}】已收到本轮发言（${req.humanText.length} 字）。未识别到 @ 指定的在册成员，本轮仅回复不派单，已暂停等待人类指示。`
    },
  }
  try {
    ctx.orchestrator.registerBrain(brain)
  } catch (e) {
    // brain-llm 已注册真大脑时这里会 duplicate_brain —— 正常降级，不刷错误栈。
    if ((e as { code?: string }).code === 'duplicate_brain') {
      ctx.logger.info('[brain-stub] 真大脑（brain-llm）已在位 —— 本占位大脑不注册')
    } else {
      throw e
    }
  }

}
