// policy/space-authz —— 授权策略（纯函数，零 IO，零状态）。
//
// 策略不实现能力，只包裹能力（MODULE-PLAN 第 3.4 节）：本包回答三件事，
// 全部承旧 domain/coordinator.go + project_memory 业务硬约束：
//   1. 谁被授权 —— 授权名单（三个目标 agent，**协调者不在名单**）
//   2. NLP 判定的口径 —— @ 提及只是提示（mentionHints），授权与否由大脑读
//      人类原话判断；本包**不做**字符串路由（那正是待定 5 禁止的）
//   3. 三级兜底 —— 大脑原始输出 → CoordinatorDecision 的解析：
//        0 层  合法 JSON（reply/reason/delegate）→ 直接采用
//        1 层  纯文本无委托标志 → 整段只当协调者回复（不委托）
//        2 层  坏 JSON → 正则救回 reply/reason/target/instruction
//        3 层  明说「将转达/委托 <目标>」→ 补委托，instruction 用人类原话
//      护栏：负面语气（不/别/没让…）、多目标歧义、空输出 → 不委托、
//      不报错、只暂停，且**每次兜底/护栏 Warn 留原文**（warned=true 由引擎落日志）。
//
// 名单外目标的**拒绝**不在这里：解析器只忠实转述大脑说了什么，
// 「目标在不在名单」由引擎裁决（invalid_target）—— 职责分家见 seam 头注。
import type { CoordinatorDecision, Delegation } from 'space-orchestrator'
import { isTargetAgentRole } from 'space-session'
import type { Membership, Role } from 'space-session'

// ── 授权名单 ──────────────────────────────────────────────────────────────

/**
 * 某会话当前可被授权的目标名单：在册（active）成员里角色属于目标 agent 的
 * 那些角色。协调者/DRI/成员一律不在名单（承旧 AgentOrder 刻意排除 coordinator）。
 */
export function authorizedTargets(members: readonly Membership[]): Role[] {
  const seen = new Set<Role>()
  for (const m of members) {
    if (m.status !== 'active') continue
    if (isTargetAgentRole(m.role)) seen.add(m.role)
  }
  return [...seen]
}

/** 目标是否在授权名单内（名单外必拒的判据，引擎逐次调用）。
 *  名单以 string 表示：会话目标角色与已加入会话的共享 Agent 标题都可授权，
 *  授权校验逐项 includes，元素类型不参与判断。 */
export function isAuthorizedTarget(target: string, targets: readonly string[]): boolean {
  return (targets as readonly string[]).includes(target)
}

// ── 三级兜底解析 ──────────────────────────────────────────────────────────

/** 兜底层级：0=直接解析 1=纯文本只回复 2=坏 JSON 正则救回 3=「将转达」补委托。 */
export type FallbackLevel = 0 | 1 | 2 | 3

export interface ParsedDecision {
  /** 总是有值（reply 可为空串）；delegate=null 表示本轮只商议。 */
  decision: CoordinatorDecision
  level: FallbackLevel
  /** true = 走了兜底或护栏，引擎必须 Warn 并留原文（铁律 2）。 */
  warned: boolean
  /** 一句话说明走了哪条路（进日志，给人看）。 */
  note: string
}

/** 负面语气护栏：出现即不委托（承旧「负面语气不委托不报错只暂停」）。 */
const NEGATIVE_RE = /(不必|不用|不要|不让|别让|别再|没让|未让|先不|暂不|先讨论|只商议|仅商议|不委托|不转达)/

/** 3 层的委托话术：明说要把任务转给某个目标。 */
const DELEGATE_PHRASE_RE = /(将转达|将委托|转达给|委托给|转交给|交给)/

/** 坏 JSON 的字段救回（宽松匹配键名与值，容忍截断/多余逗号/中文引号）。 */
function rescueField(raw: string, key: string): string {
  const m = raw.match(new RegExp(`["“]?(?:${key})["”]?\\s*[:：]\\s*["“]([^"”]*)["”]`))
  return m ? m[1]! : ''
}

/** 在文本里找出被提到的目标（按名字逐字匹配）。 */
function mentionedTargets(text: string, targets: readonly string[]): string[] {
  return targets.filter((r) => text.includes(r))
}

function trim(s: unknown): string {
  return typeof s === 'string' ? s.trim() : ''
}

export interface ParseInput {
  /** 人类原话（3 层补委托时 instruction 的来源）。 */
  humanText: string
  /** 名单 = 会话目标角色 + 已加入会话的 Agent title（校验归引擎）。 */
  targets: readonly string[]
}

/**
 * 大脑原始输出 → CoordinatorDecision。**纯函数**：同样的输入永远同样的
 * 输出 —— 待定 5 的口径（凡能写成「给定输入 → 期望输出」的必须有会红的断言）
 * 就是靠这一点成立。
 */
export function parseCoordinatorOutput(raw: string, input: ParseInput): ParsedDecision {
  const text = raw.trim()

  // 护栏：空输出 —— 不委托、不报错、只暂停（警告留原文）。
  if (!text) {
    return {
      decision: { reply: '', reason: '', delegate: null },
      level: 1,
      warned: true,
      note: '协调者返回空输出，本轮不委托只暂停',
    }
  }

  // 0 层：合法 JSON（必须以 { 开头且解析成功 —— 纯文本不会误入）。
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      const delegateObj = obj.delegate as Record<string, unknown> | null | undefined
      let delegate: Delegation | null = null
      if (delegateObj && typeof delegateObj === 'object') {
        delegate = {
          target: trim(delegateObj.target),
          instruction: trim(delegateObj.instruction),
        }
        if (!delegate.target) delegate = null
      }
      return {
        decision: { reply: trim(obj.reply), reason: trim(obj.reason), delegate },
        level: 0,
        warned: false,
        note: '大脑输出为合法 JSON，直接采用',
      }
    } catch {
      // 落到下面的兜底链 —— 不在这里 return。
    }
  }

  // 护栏：负面语气 —— 大脑自己说「不」，就别替它决定委托。
  if (NEGATIVE_RE.test(text)) {
    return {
      decision: { reply: text, reason: '', delegate: null },
      level: 1,
      warned: true,
      note: '检测到负面语气，按只回复处理（不委托不报错）',
    }
  }

  // 护栏：多目标歧义 —— 一轮只允许一个目标槽位（承旧 Delegation 单槽位）。
  const mentioned = mentionedTargets(text, input.targets)
  if (mentioned.length >= 2) {
    return {
      decision: { reply: text, reason: '', delegate: null },
      level: 1,
      warned: true,
      note: `检测到多个目标（${mentioned.join('、')}），多目标歧义不委托，只暂停`,
    }
  }

  // 2 层：坏 JSON —— 正则救回字段；救回 target 就按委托走（引擎再校验名单）。
  if (text.includes('{')) {
    const reply = rescueField(text, 'reply')
    const reason = rescueField(text, 'reason')
    const target = rescueField(text, 'target')
    const instruction = rescueField(text, 'instruction')
    if (reply || reason || target || instruction) {
      return {
        decision: {
          reply,
          reason,
          delegate: target ? { target, instruction: instruction || input.humanText } : null,
        },
        level: 2,
        warned: true,
        note: '坏 JSON，正则救回字段',
      }
    }
  }

  // 3 层：明说「将转达/委托 <目标>」—— 补委托，instruction 用人类原话。
  if (DELEGATE_PHRASE_RE.test(text) && mentioned.length === 1) {
    return {
      decision: {
        reply: text,
        reason: '从委托话术补回委托（instruction 取人类原话）',
        delegate: { target: mentioned[0]!, instruction: input.humanText },
      },
      level: 3,
      warned: true,
      note: `纯文本明说委托 ${mentioned[0]}，用人类原话补委托`,
    }
  }

  // 1 层：纯文本无委托标志 —— 整段只当协调者回复（含「先讨论」「只商议」：
  // 落在这里，delegate=null 即暂停语义，不需要专门关键词路由 —— 那才是
  // 待定 5 禁止的字符串识别）。
  return {
    decision: { reply: text, reason: '', delegate: null },
    level: 1,
    warned: false,
    note: '纯文本无委托标志，只当协调者回复',
  }
}
