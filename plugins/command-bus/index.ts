// command-bus —— ctx.commands 服务实例的**唯一**提供者。
//
// 谁提供谁创建：CommandService（seam/space-command，纯内存注册表 + Parse/
// Dispatch 机制）只能有一个提供者，指令实现插件、入站路由、P3 的 authz
// 都依赖这个实例 —— 各自 new 会互相覆盖 ctx.commands。
// 本插件因此零配置、零业务：只负责「让 ctx.commands 存在」。
import type { Context } from 'cordis'
import { CommandService } from 'space-command'

export const name = 'command-bus'

export function apply(ctx: Context) {
  new CommandService(ctx)
}
