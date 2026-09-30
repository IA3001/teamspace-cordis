// agent-coder-stub —— 第一个 Coding Agent 的**入驻示例**（P6，2026-09-29）。
//
// 入驻形状（本包就是铁律 4 的证据）：
//   新增 plugins/agent-coder-stub/（本文件）+ 新增
//   packages/bundle/space-agent-coder-stub/（自带 patch 一行，compose 扫描自动发现）
//   —— 既有文件零改动。停用 = 用户层给这行写 disabled: true，同样零改动。
//
// 行为（待定 9 用户拍板：人类 @ 直派最小回路，stub 回执，不接真模型）：
//   报到：apply 时向 ctx.agents 注册 agent.coder（kind=coding，初始 idle）
//   领任务：/tell @<agent> <任务> → idle→working
//   干活（P6 收尾改为真落盘 stub）：领工作区（ctx.workdir.claim）→ 任务写成
//     工作区内文件（task-<ISO时间>.md，经 ctx.workdir.resolve 路径校验落盘）
//     → 状态机 working→done→idle → 回执含【工作区绝对路径 + 产物文件清单】
//   委托链：订阅 'orchestrator/delegate'（orchestrator 消费大脑委托后 emit），
//     认领 target 命中本 agent（title/id 双口径，承 /tell 先例）的委托，
//     走**同一条干活路径**，干完经 ctx.orchestrator.reportCodingResult 收执
//     （回执落时间线 + await_human 暂停 —— 收到反馈必须停）。
//
// 提示词（promptRef）待定 10：等用户给 4 个角色提示词原文后接入。
// /tell 派活口暂住本包；第二个真 agent 入驻时升格为独立机制插件（记账在案）。
import { writeFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { AgentError } from 'space-agent'
import { CommandError } from 'space-command'
import type { CommandCtx, CommandService } from 'space-command'
import type { DelegatePayload } from 'space-orchestrator'

export const name = 'agent-coder-stub'
// cordis 严格注入：workdir（P6 收尾：领工作区落盘）+ orchestrator（收执口）。
export const inject = ['agents', 'commands', 'workdir', 'orchestrator']

const AGENT_ID = 'agent.coder'
const TITLE = '编码者'

export function apply(ctx: Context) {
  // ── 报到（入驻 = 向 space-agent 缝注册；重复入驻即炸 —— 重启是新进程，无残留）──
  ctx.agents.register({
    id: AGENT_ID,
    kind: 'coding',
    title: TITLE,
    // capabilities 开放词表（seam 词汇）：stub 只声明 coding
    capabilities: ['coding'],
  })

  /**
   * 干活路径（唯一一份）：/tell 直派与 orchestrator 委托都走这里。
   * 流程：idle→working（领取）→ 领工作区 → 任务文件落盘（经 workdir.resolve
   * 路径校验）→ working→done→idle（状态机走满一圈）→ 回执文本（含工作区
   * 绝对路径 + 产物清单）。onResult 回调由调用方提供：/tell 直接把回执当
   * 指令回复；委托链把回执交 orchestrator 收执口（落时间线 + 暂停）。
   */
  async function perform(task: string, onResult: (receipt: string) => void): Promise<void> {
    try {
      ctx.agents.setStatus(AGENT_ID, 'working')
    } catch (e) {
      if (e instanceof AgentError && e.code === 'invalid_transition') {
        const snap = ctx.agents.get(AGENT_ID)
        throw new Error(`「${TITLE}」正忙（${snap.status}），暂不接新任务`)
      }
      throw e
    }
    try {
      const handle = await ctx.workdir.claim(AGENT_ID)
      const filename = `task-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
      const filepath = ctx.workdir.resolve(AGENT_ID, filename) // execdir 铁则：逃出工作区即炸
      await writeFile(filepath, [
        `# 任务（${TITLE}）`,
        '',
        `- 领取时间：${new Date().toISOString()}`,
        '- 来源：stub（P6 机制闭环，未接真模型）',
        '',
        '## 指令',
        '',
        task,
        '',
        '## 产物说明',
        '',
        '本文件即本轮交付物（写文件级 stub）：证明「委托 → 领工作区 → 落盘」',
        '全链路可观测。真模型接入后此处替换为真实产物。',
        '',
      ].join('\n'), 'utf8')
      ctx.agents.setStatus(AGENT_ID, 'done')
      ctx.agents.setStatus(AGENT_ID, 'idle')
      onResult(
        `[@${TITLE}] 已领任务：${task}\n` +
        `回执：stub 已交付（写文件级 stub，未接真模型）\n` +
        `【工作区】${handle.root}\n` +
        `【产物清单】${filename}`,
      )
    } catch (e) {
      // 干活中途失败：状态回 idle（任务作废），错误原样上抛给调用方处置。
      try { ctx.agents.setStatus(AGENT_ID, 'idle') } catch { /* 已是 idle 则忽略 */ }
      throw e
    }
  }

  // ── 委托链（P6 收尾）：orchestrator 消费大脑委托后 emit，本 agent 认领 ────
  ctx.on('orchestrator/delegate', (p: DelegatePayload) => {
    // 双口径认领（承 /tell 先例）：target = 名册 title 或 id。
    if (p.target !== TITLE && p.target !== AGENT_ID) return
    void perform(p.instruction, (receipt) => {
      // 收执口：回执落时间线（authorKind='agent'）+ await_human 暂停。
      ctx.orchestrator.reportCodingResult(p.sessionId, p.target, receipt)
    }).catch((e) => {
      ctx.logger.error('[agent-coder-stub] 委托任务执行失败：%s', (e as Error).message)
    })
  })

  // ── 派活口：人类 @ 直派（不经协调者；会议机器人明确拒收并指路）────────
  ctx.commands.register({
    name: 'tell',
    usage: '/tell @<agent名或id> <任务> —— 把任务直派给一个已入驻的 agent（不经协调者）',
    minArgs: 2,
    maxArgs: -1,
    run: async (c: CommandCtx) => {
      const target = c.args[0]!
      if (!target.startsWith('@') || target.length < 2) {
        throw new CommandError('bad_args', `直派目标必须以 @ 开头（例：/tell @${TITLE} 实现登录页）。用法：/tell @<agent名或id> <任务>`)
      }
      const token = target.slice(1)
      // 解析：先按 id 精确匹配（机器口径），再按 title（人类口径）。
      const snap = ctx.agents.list().find((a) => a.descriptor.id === token || a.descriptor.title === token)
      if (!snap) {
        const roster =
          ctx.agents.list().map((a) => `${a.descriptor.title}(${a.descriptor.id})`).join('、') ||
          '当前没有任何已入驻 agent'
        // 未注册必带可用清单（承指令缝口径）
        throw new CommandError('bad_args', `找不到 agent「@${token}」。已入驻：${roster}`)
      }
      if (snap.descriptor.kind === 'meeting') {
        // 会议机器人走 orchestrator 调度链，不接直派（开会不会被本指令旁路 —— 铁律 4）
        throw new CommandError('bad_args', `「${snap.descriptor.title}」是会议机器人，由协调者调度，不接直派`)
      }
      const task = c.arg.slice(target.length).trim()
      // 与委托链同一条干活路径（指令缝 run 原生支持 Promise<Reply>，直接 await）。
      // 正忙检测在 perform 内：领取时 setStatus(working) 照状态机白名单拒绝。
      let receipt = ''
      try {
        await perform(task, (r) => { receipt = r })
      } catch (e) {
        // perform 的正忙/失败错误统一转回指令缝口径（bad_args；「正忙」字样 A11 断言依赖）
        throw new CommandError('bad_args', (e as Error).message)
      }
      return { text: receipt }
    },
  })
}
