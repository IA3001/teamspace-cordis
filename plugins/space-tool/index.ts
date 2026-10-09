// space-tool —— space-tool 缝（工具层）的本机实现：工具注册表 + 受控调用 + 留痕。
//
// 语义（seam 契约照表执法）：
//   · register：重名 → ToolError('duplicate_tool')（重名即编程错误，注册期就炸，承断言 ⑥）。
//   · invoke：未知工具 → ToolError('unknown_tool')；config.allow 配置了 allowlist
//     则清单外的 toolId 一律 ToolError('not_allowed')（缺省全放行）；handler 执行体
//     计时（Date.now 差）并包 try/catch —— 抛错包成
//     ToolResult{ ok:false, code:'handler_error', output:错误消息 }，成功 { ok:true, output }。
//   · list：按 id 稳定排序（给 Agent 的上下文注入层用）。
//   · 每笔调用 console.log 一行留痕（铁律 2，可观测）：
//       [space-tool] <invoker.id> -> <toolId> ok/fail <costMs>ms
//
// 分层（docs/ARCHITECTURE.md 反模式 2）：能力方经本注册表登记，使用方（Agent 层）
// 只许 ctx.tools.invoke 按名调用，不得绕过注册表直连能力 —— 闸门与审计在一处。
import type { Context } from 'cordis'
import z from 'schemastery'
import { ToolError, ToolService } from 'space-tool'
import type { ToolDescriptor, ToolInvoker, ToolResult } from 'space-tool'

/**
 * 配置面板 schema（5172 自动渲染）：调用白名单（字符串数组）。
 */
export const Config = z.object({
  allow: z.array(z.string())
    .description('调用白名单：配置了就只放行清单内的 toolId（其余 not_allowed）；不配置 = 全放行；空数组 = 全部拒绝（显式收紧的合法取值）'),
})

/** 运行时取值形状（兼容旧取值：allow 可选，undefined = 全放行）。 */
export interface Config {
  /**
   * 调用白名单：配置了就只允许清单内的 toolId 被调用（其余 not_allowed）；
   * 缺省全放行。空数组 = 全部拒绝（显式收紧的合法取值）。
   */
  allow?: string[]
}

/** 注册表本体：内存 Map，进程生命周期内有效（重启即空，注册方在 apply 重报）。 */
export class ToolRegistry extends ToolService {
  private readonly registry = new Map<string, ToolDescriptor>()
  private readonly allow: ReadonlySet<string> | null

  constructor(ctx: Context, config: Config) {
    super(ctx) // Service 基类构造即 provide（ctx.tools，承 llm-openai / agent-runtime 同款）
    this.allow = Array.isArray(config.allow) ? new Set(config.allow) : null
  }

  register(desc: ToolDescriptor): void {
    if (this.registry.has(desc.id)) {
      throw new ToolError('duplicate_tool', `工具「${desc.id}」已注册（重名即编程错误，注册期就炸）`)
    }
    this.registry.set(desc.id, desc)
  }

  async invoke(toolId: string, args: string, invoker: ToolInvoker): Promise<ToolResult> {
    const desc = this.registry.get(toolId)
    if (!desc) {
      throw new ToolError('unknown_tool', `未知工具「${toolId}」，可用清单见 ctx.tools.list()`)
    }
    if (this.allow && !this.allow.has(toolId)) {
      throw new ToolError('not_allowed', `工具「${toolId}」不在调用白名单内（调用者 ${invoker.id}）`)
    }
    const start = Date.now()
    try {
      const output = await desc.handler(args, invoker)
      const costMs = Date.now() - start
      console.log(`[space-tool] ${invoker.id} -> ${toolId} ok ${costMs}ms`)
      return { toolId, ok: true, output: String(output), costMs }
    } catch (e) {
      const costMs = Date.now() - start
      console.log(`[space-tool] ${invoker.id} -> ${toolId} fail ${costMs}ms`)
      return {
        toolId,
        ok: false,
        code: 'handler_error',
        output: (e as Error)?.message ?? String(e),
        costMs,
      }
    }
  }

  list(): ToolDescriptor[] {
    // 按 id 稳定排序（seam 契约）。
    return [...this.registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}

export const name = 'space-tool'
// 纯服务提供者：注册表本身不依赖任何上游服务。
export const inject: string[] = []

export function apply(ctx: Context, config: Config = {}) {
  new ToolRegistry(ctx, config)
}
