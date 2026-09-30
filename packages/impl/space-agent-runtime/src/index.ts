// space-agent-runtime —— space-agent-runtime 缝的本机实现（P8，2026-09-30）。
//
// 职责（P6 在案记账的升格兑现）：coding 类**共享干活路径**从 agent-coder-stub
// 升格为机制 —— 第二、三个 coding agent（agent-tester-stub / agent-reviewer-stub）
// 入驻时，agent 包收敛为「入驻描述符 + 委托认领」，本包承载唯一的干活路径：
//   perform：idle→working（正忙即拒）→ 领工作区（ctx.workdir.claim）→ 任务文件
//   落盘（经 ctx.workdir.resolve 路径校验，execdir 铁则）→ promptRef 绑定的
//   提示词随任务落盘（ctx.prompts，缺席/未预置降级不炸）→ working→done→idle
//   （状态机走满一圈）→ 回执（含【工作区】【产物清单】，有提示词时含【提示词】）。
// 同时承接 /tell 直派口（从 coder-stub 迁入 —— 直派本就与「编码者」无关，
// 任何已入驻 agent 都可被直派）。
//
// 依赖方向（lint:deps 断言①）：impl 只准依赖 seams —— 本包依赖
// space-agent-runtime（契约）+ space-agent（名册/状态机）+ space-workdir
// （领地与路径边界）+ space-prompt（提示词内容）+ space-command（/tell 词汇）。
import { writeFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { AgentError } from 'space-agent'
import { AgentRuntimeService } from 'space-agent-runtime'
import type { CodingReceipt } from 'space-agent-runtime'
import { CommandError } from 'space-command'
import type { CommandCtx } from 'space-command'

export class AgentRuntime extends AgentRuntimeService {
  async perform(agentId: string, task: string): Promise<CodingReceipt> {
    // 名册制：没入驻就没有干活路径（未知 → not_found，space-agent 错误码）。
    const snap = this.ctx.agents.get(agentId)
    const title = snap.descriptor.title
    try {
      this.ctx.agents.setStatus(agentId, 'working')
    } catch (e) {
      if (e instanceof AgentError && e.code === 'invalid_transition') {
        // 「正忙」字样是 /tell 的 A11 断言依赖（verify-agents），保持原话。
        throw new AgentError('invalid_transition', `「${title}」正忙（${snap.status}），暂不接新任务`)
      }
      throw e
    }
    try {
      const handle = await this.ctx.workdir.claim(agentId)
      const filename = `task-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
      const filepath = this.ctx.workdir.resolve(agentId, filename) // execdir 铁则：逃出工作区即炸
      // 提示词段（P8，待定 10 形态）：promptRef 绑定的**内容**随任务落盘 ——
      // 引用（AgentDescriptor.promptRef）与内容（prompt_templates）分离，
      // 换文案零改名单。prompts 服务缺席（裸 harness）或 ref 未预置 → 降级。
      let promptRef: string | null = snap.descriptor.promptRef ?? null
      let promptTitle: string | null = null
      let promptBody: string | null = null
      if (promptRef) {
        try {
          const tpl = this.ctx.prompts.get(promptRef)
          promptTitle = tpl.title
          promptBody = tpl.body
        } catch {
          this.ctx.logger.warn(
            '[agent-runtime] 提示词 "%s" 不可用（服务缺席或未预置），任务文件降级不含提示词段',
            promptRef,
          )
          promptTitle = null
          promptBody = null
        }
      }
      const lines: string[] = [
        `# 任务（${title}）`,
        '',
        `- 领取时间：${new Date().toISOString()}`,
        '- 来源：stub（机制闭环，未接真模型）',
        '',
        '## 指令',
        '',
        task,
        '',
      ]
      if (promptBody) {
        lines.push(
          '## 提示词（promptRef 绑定）',
          '',
          `- ref：${snap.descriptor.promptRef}`,
          `- title：${promptTitle}`,
          '',
          promptBody,
          '',
        )
      }
      lines.push(
        '## 产物说明',
        '',
        '本文件即本轮交付物（写文件级 stub）：证明「委托 → 领工作区 → 落盘」',
        '全链路可观测。真模型接入后此处替换为真实产物。',
        '',
      )
      await writeFile(filepath, lines.join('\n'), 'utf8')
      this.ctx.agents.setStatus(agentId, 'done')
      this.ctx.agents.setStatus(agentId, 'idle')
      const receipt =
        `[@${title}] 已领任务：${task}\n` +
        `回执：stub 已交付（写文件级 stub，未接真模型）\n` +
        (promptTitle ? `【提示词】${promptTitle}（ref=${snap.descriptor.promptRef}）\n` : '') +
        `【工作区】${handle.root}\n` +
        `【产物清单】${filename}`
      return {
        agentId,
        title,
        task,
        root: handle.root,
        files: [filename],
        receipt,
        promptRef: promptBody ? promptRef : null,
        promptTitle,
      }
    } catch (e) {
      // 干活中途失败：状态回 idle（任务作废），错误原样上抛给调用方处置。
      try { this.ctx.agents.setStatus(agentId, 'idle') } catch { /* 已是 idle 则忽略 */ }
      throw e
    }
  }
}

export const name = 'space-agent-runtime'
// cordis 严格注入：agents（名册/状态机）+ workdir（领地落盘）+ commands（/tell）
// + prompts（提示词内容）。prompts 由 space-store-sqlite 提供（组合根常驻）。
export const inject = ['agents', 'workdir', 'commands', 'prompts']

export function apply(ctx: Context) {
  const runtime = new AgentRuntime(ctx)

  // ── 直派口：人类 @ 直派（不经协调者；会议机器人明确拒收并指路）────────
  // P8 从 agent-coder-stub 原样迁入（在案记账）：正忙检测在 perform 内。
  ctx.commands.register({
    name: 'tell',
    usage: '/tell @<agent名或id> <任务> —— 把任务直派给一个已入驻的 agent（不经协调者）',
    minArgs: 2,
    maxArgs: -1,
    run: async (c: CommandCtx) => {
      const target = c.args[0]!
      if (!target.startsWith('@') || target.length < 2) {
        throw new CommandError('bad_args', `直派目标必须以 @ 开头（例：/tell @编码者 实现登录页）。用法：/tell @<agent名或id> <任务>`)
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
      let receipt = ''
      try {
        const r = await runtime.perform(snap.descriptor.id, task)
        receipt = r.receipt
      } catch (e) {
        // perform 的正忙/失败错误统一转回指令缝口径（bad_args；「正忙」字样 A11 断言依赖）
        throw new CommandError('bad_args', (e as Error).message)
      }
      return { text: receipt }
    },
  })
}
