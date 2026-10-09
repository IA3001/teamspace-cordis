// flow-commands —— 确定性服务流程指令（MC 式，2026-10-01，用户拍板）。
//
// 输入一条指令，多个 Agent 按固定步骤链接力执行：/code <任务> = 编码者 → 测试者
// → 评审者。与「@提及的自由协作」双轨并存（docs/ARCHITECTURE.md 第七节）：
// 自由协作由大脑在自治预算内决定下一步；本插件由指令定义的固定流程决定，
// 每步经 'orchestrator/delegate' 交给对应 agent，结果事件回流自动推进。
//
// 已知边界（诚实标注）：
//   · agent 忙时 delegate 无人认领会滞留 —— 不重试（承「不猜」口径），
//     用户可重新发起；流程每会话串行，发起前有提示。
//   · 流程状态进程内存，重启丢失（与 orchestrator turns 同口径）。
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { SessionEvent } from 'space-event'

export const name = 'flow-commands'
export const inject = ['commands', 'eventLog', 'session', 'agents', 'orchestrator']

/**
 * 配置面板 schema（5172 自动渲染）：dict 值 = 步骤链（agent 名册 title 或 id）。
 * 运行时与 DEFAULT_FLOWS 合并：面板配置的流程覆盖同名缺省流程。
 */
export const Config = z.object({
  flows: z.dict(z.array(z.string()))
    .description('指令→Agent步骤链，如 code:[编码者,测试者,代码审查者]')
    .default({}),
})

/** 运行时取值形状（兼容旧取值：flows 可选）。 */
export interface Config {
  /** 指令 → 步骤链（agent 名册 title 或 id）。缺省三条 MC 式服务流程。 */
  flows?: Record<string, string[]>
}

/** 缺省流程（title 与 agent-*-stub 的名册 title 逐字一致）。 */
const DEFAULT_FLOWS: Record<string, string[]> = {
  code: ['编码者', '测试者', '代码审查者'],
  test: ['测试者', '代码审查者'],
  review: ['代码审查者'],
}

/** 进行中的流程实例（每会话至多一个 —— 串行，防 agent 忙滞留叠加）。 */
interface Flow {
  name: string
  steps: string[]
  idx: number // 下一个待完成步骤的下标
  task: string
}

export function apply(ctx: Context, config: Config = {}) {
  // 面板配置覆盖同名缺省流程（未配置则全用缺省三条 MC 式服务流程）。
  const flows = { ...DEFAULT_FLOWS, ...(config.flows ?? {}) }
  /** 会话 → 进行中流程。进程内存（重启丢失，同 orchestrator turns 口径）。 */
  const running = new Map<string, Flow>()

  /** 落系统事件（自动广播），返回事件 id（作 delegate 的 eventId 追溯锚）。 */
  function saySystem(sessionId: string, text: string): string {
    const event: SessionEvent = ctx.eventLog.append({
      id: randomUUID(),
      sessionId,
      authorId: null,
      phaseId: null,
      authorKind: 'system',
      kind: 'system',
      text,
      mentions: [],
      toolCalls: [],
      replyMode: '',
    })
    return event.id
  }

  /** 名册里是否存在该 title/id 的 coding agent；在的话返回快照。 */
  function findAgent(title: string) {
    return ctx.agents.list('coding').find((a) => a.descriptor.id === title || a.descriptor.title === title)
  }

  /**
   * 单套 Agent 全局闸门（2026-10-01，用户拍板）：Agent 是全服务器单例，
   * 同一时刻只能服务一个会话 —— 流程启动/推进前检查每个步骤的 agent
   * 状态必须是 idle，否则拒绝并指明谁在忙（不排队不重试，承「不猜」口径）。
   */
  function busyAgent(steps: readonly string[]): string | null {
    for (const s of steps) {
      const a = findAgent(s)
      if (a && a.status === 'working') return `${a.descriptor.title}（${a.descriptor.id}）`
    }
    return null
  }

  for (const [name, steps] of Object.entries(flows)) {
    ctx.commands.register({
      name,
      usage: `/${name} <任务> —— 服务流程：${steps.join(' → ')}`,
      minArgs: 1,
      maxArgs: -1,
      run: (c) => {
        if (!ctx.session.getSession(c.sessionId)) {
          return { text: `会话 ${c.sessionId} 不存在` }
        }
        if (running.has(c.sessionId)) {
          const cur = running.get(c.sessionId)!
          const left = cur.steps.slice(cur.idx).join(' → ')
          return { text: `已有服务流程进行中（剩余：${left}），完成后再发起` }
        }
        const missing = steps.find((s) => !findAgent(s))
        if (missing) {
          return { text: `流程成员「${missing}」未入驻（检查对应 agent 插件与名册），流程未启动` }
        }
        const busy = busyAgent(steps)
        if (busy) {
          return { text: `「${busy}」正在其它任务中（单套 Agent 同一时刻只服务一个会话）。等它空闲后再发起 /${name}` }
        }
        const task = c.arg.trim()
        const eventId = saySystem(
          c.sessionId,
          `⚙ 服务流程 [${name}] 启动：${task}（步骤：${steps.join(' → ')}）`,
        )
        running.set(c.sessionId, { name, steps: [...steps], idx: 1, task })
        ctx.orchestrator.beginExternalDelegate(c.sessionId, eventId, steps[0]!, task)
        return { text: `流程已启动：交给「${steps[0]}」；后续步骤自动接力，结果见时间线。` }
      },
    })
  }

  // /flows（2026-10-01）：列出当前可用的服务流程 —— 用户discoverable。
  ctx.commands.register({
    name: 'flows',
    usage: '/flows —— 列出可用的服务流程（MC 式指令）',
    minArgs: 0,
    maxArgs: 0,
    run: () => {
      const lines = Object.entries(flows)
        .map(([k, v]) => `  /${k} <任务> —— ${v.join(' → ')}`)
        .join('\n')
      const cur = [...running.entries()]
        .map(([sid, f]) => `会话 ${sid}：${f.name}（${f.steps[f.idx - 1]} 进行中）`)
        .join('；')
      return { text: `可用服务流程：\n${lines}\n${cur ? `进行中：${cur}` : '当前无进行中流程。'}` }
    },
  })

  // 接力：当前步骤 agent 的结果事件回流（reportCodingResult 落的 authorKind='agent'
  // 事件）→ 推进到下一步；最后一步完成即收束。宽容匹配 id 或 title。
  ctx.on('space/event-appended', ({ event }) => {
    if (event.authorKind !== 'agent') return
    const flow = running.get(event.sessionId)
    if (!flow) return
    const doneStep = flow.steps[flow.idx - 1]!
    const agentOk = ctx.agents
      .list('coding')
      .some((a) => a.descriptor.id === event.authorId && (a.descriptor.title === doneStep || a.descriptor.id === doneStep))
    // 兜底：agentId 与步骤 title 直接对不上时，按事件作者 id 含步骤 title 宽容判定。
    if (!agentOk && !(event.authorId ?? '').includes(doneStep)) return

    if (flow.idx < flow.steps.length) {
      const next = flow.steps[flow.idx]!
      // 推进前同样过全局闸门：下一步的 agent 在别的会话忙 → 暂停流程（诚实
      // 留痕），用户等它空闲后重新发起；不排队不重试（承「不猜」口径）。
      const busy = busyAgent([next])
      if (busy) {
        saySystem(event.sessionId, `⚙ 流程 [${flow.name}] 暂停：「${next}」正在其它任务中。等它空闲后重新发起 /${flow.name}（已完成步骤不重做，请自行衔接）`)
        running.delete(event.sessionId)
        return
      }
      flow.idx++
      const eventId = saySystem(
        event.sessionId,
        `⚙ 流程推进（${flow.idx}/${flow.steps.length}）：交给「${next}」`,
      )
      ctx.orchestrator.beginExternalDelegate(
        event.sessionId,
        eventId,
        next,
        `${flow.task}\n[流程上下文] 上一步（${doneStep}）结论：${event.text.slice(0, 300)}`,
      )
    } else {
      saySystem(event.sessionId, `⚙ 服务流程 [${flow.name}] 完成（${flow.steps.join(' → ')}）`)
      running.delete(event.sessionId)
    }
  })

  console.log(`[${name}] 就绪：${Object.keys(flows).map((k) => `/${k}`).join(' ')}（确定性服务流程）`)
}
