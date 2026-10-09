// tool-workdir —— 能力方注册示例：把 coding 工作区能力（agentRuntime.perform）
// 注册成工具注册表里的一个工具（tool.workdir-perform）。
//
// 分层章程（docs/ARCHITECTURE.md 反模式 2）：Agent 层使用工具**一律**走
//   ctx.tools.invoke('tool.workdir-perform', json, { id, sessionId })
// 不得绕过注册表直连 ctx.agentRuntime —— 能力方注册、使用方按名调用，
// 白名单闸门（space-tool 的 allow）与每笔调用留痕都在注册表一处。
//
// args 契约：JSON 字符串 { agentId, instruction }。
// 解析失败 / 字段缺失 → handler 抛 Error，由 space-tool 包成
// ToolResult{ ok:false, code:'handler_error', output:错误消息 }。
import type { Context } from 'cordis'

export const name = 'tool-workdir'
// tools（向注册表登记）+ agentRuntime（handler 内桥接的共享干活路径）。
export const inject = ['tools', 'agentRuntime']

export function apply(ctx: Context) {
  ctx.tools.register({
    id: 'tool.workdir-perform',
    title: '工作区任务执行',
    capabilities: ['workdir'],
    handler: async (args, invoker) => {
      // 坏参就地抛 Error（本 handler 不吞错 —— seam 契约）。
      let parsed: unknown
      try {
        parsed = JSON.parse(args)
      } catch (e) {
        throw new Error(`args 必须是 JSON 对象 {agentId, instruction}：解析失败（${(e as Error).message}）`)
      }
      const { agentId, instruction } = (parsed ?? {}) as Record<string, unknown>
      if (typeof agentId !== 'string' || !agentId) throw new Error('args.agentId 缺失或不是字符串')
      if (typeof instruction !== 'string' || !instruction) throw new Error('args.instruction 缺失或不是字符串')

      // 桥接共享干活路径：领工作区 → 任务落盘（+ 真模型产物）→ 状态机走满一圈 → 回执。
      // CodingReceipt = { agentId, title, task, root, files, receipt,
      //                   promptRef, promptTitle, mode, model }（impl/space-agent-runtime）。
      // invoker（{id, sessionId}）在此只作身份透传审计；真正的闸门在 space-tool。
      const r = await ctx.agentRuntime.perform(agentId, instruction)
      // 按实际返回形状转成一段摘要文本（机器可断言字段 + 人类可读回执）。
      return [
        `agent=${r.agentId}（${r.title}） mode=${r.mode}${r.model ? ` model=${r.model}` : ''}`,
        `workspace=${r.root}`,
        `files=${r.files.join('、')}`,
        '',
        r.receipt,
      ].join('\n')
    },
  })
}
