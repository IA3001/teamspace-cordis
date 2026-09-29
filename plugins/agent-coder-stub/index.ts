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
//   回执：stub 立即交付 → working→done→idle（状态机走满一圈，可领下一个）
//
// 提示词（promptRef）待定 10：等用户给 4 个角色提示词原文后接入。
// /tell 派活口暂住本包；第二个真 agent 入驻时升格为独立机制插件（记账在案）。
import type { Context } from 'cordis'
import { AgentError } from 'space-agent'
import { CommandError } from 'space-command'
import type { CommandCtx, CommandService } from 'space-command'

export const name = 'agent-coder-stub'
export const inject = ['agents', 'commands']

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

  // ── 派活口：人类 @ 直派（不经协调者；会议机器人明确拒收并指路）────────
  ctx.commands.register({
    name: 'tell',
    usage: '/tell @<agent名或id> <任务> —— 把任务直派给一个已入驻的 agent（不经协调者）',
    minArgs: 2,
    maxArgs: -1,
    run: (c: CommandCtx) => {
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
      // 领任务：状态机白名单天然防并发（working/paused 中再派 → invalid_transition）
      try {
        ctx.agents.setStatus(snap.descriptor.id, 'working')
      } catch (e) {
        if (e instanceof AgentError && e.code === 'invalid_transition') {
          throw new CommandError('bad_args', `「${snap.descriptor.title}」正忙（${snap.status}），暂不接新任务`)
        }
        throw e
      }
      // ── stub 干活：不接真模型，立即交付回执（P6 最小回路只验证入驻机制）──
      ctx.agents.setStatus(snap.descriptor.id, 'done')
      ctx.agents.setStatus(snap.descriptor.id, 'idle')
      return {
        text: `[@${snap.descriptor.title}] 已领任务：${task}\n回执：stub 已完成（P6 入驻示例，未接真模型；状态已归位 idle，可领下一个任务）`,
      }
    },
  })
}
