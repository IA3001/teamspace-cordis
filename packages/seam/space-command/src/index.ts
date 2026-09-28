// seam/space-command —— 能力缝。
//
// 这一层只有词汇与**机制**：Service 声明 + 类型 + 错误分类法 + Parse/Dispatch
// 两个机制函数。Parse/Dispatch/Registry 是纯内存逻辑（零 IO）—— 注册表不碰
// 数据库、不碰网络，因此不违反断言 ②（seam 无 IO 依赖）。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 elements/command/command.go，P2 2026-09-27 补真）：
//   Invocation / Reply / CommandCtx / Command
//   Parse 与 Dispatch 是本缝仅有的两个机制函数（原样继承旧系统的双机制函数口径）：
//     · 新增指令 = 注册一个 Command 实现，机制零改动
//     · 未注册指令返回带可用清单的错误，绝不静默吞掉
//     · /add 这类带长文本的指令，参数必须保留原文空格 —— Invocation.rest
//       是原文剩余部分，args 切分只是便捷视图
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    commands: CommandService
  }
}

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一次解析出的指令调用（承旧 Invocation）。 */
export interface Invocation {
  /** 指令名，不带斜杠（如 "add"）。 */
  name: string
  /** 指令名后的**原文剩余部分**（保留空格与换行 —— /add 长文本必需）。 */
  rest: string
}

/** 指令给人类的回执。 */
export interface Reply {
  text: string
}

/** 指令执行的运行时上下文（承旧 Ctx）。 */
export interface CommandCtx {
  sessionId: string
  authorId: string
  /** 指令名后的原文（保留空格与换行）。 */
  arg: string
  /** arg 按空白切分的便捷视图（/del 1、/change 2 用；不解析引号）。 */
  args: string[]
  /** 完整原始输入（含斜杠与指令名）。 */
  raw: string
}

/**
 * 一条 / 指令。新增指令 = 实现本接口并注册，机制零改动。
 *
 * usage 是**必填**的（回执与未知指令清单共用一行用法说明，没有它
 * 用户就不知道这条指令怎么用 —— 注册期为空直接抛错，不留到运行时）。
 */
export interface Command {
  /** 指令名（不带斜杠，如 "add"）。 */
  name: string
  /** 一行用法说明（未知指令清单与参数错误提示共用）。 */
  usage: string
  /** 别名（可选）。别名与主名共享同一命名空间，冲突注册期即抛。 */
  aliases?: readonly string[]
  /** 最少参数个数（按空白切分后的 args 长度）。 */
  minArgs: number
  /** 最多参数个数；-1 = 不限（/add 长文本）。 */
  maxArgs: number
  run(c: CommandCtx): Reply | Promise<Reply>
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type CommandErrorCode =
  /** 未注册指令。message 必带可用清单（或「当前没有任何可用指令」）。 */
  | 'unknown'
  /** 注册重名（主名或别名与已有冲突）。重名是编程错误，注册期就炸。 */
  | 'duplicate'
  /** 参数个数不满足 minArgs/maxArgs。message 必带该指令的 usage。 */
  | 'bad_args'

export class CommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

// ── 机制函数 ①：Parse ─────────────────────────────────────────────────────

/**
 * 判断一段输入是否是 / 指令；是则解析出指令名与剩余原文，否则返回 null。
 *
 * 只认**首字符为 '/'** 的输入（允许前置空白）：URL、句子里的斜杠、
 * 代码片段都不会误触发。解析不出指令名（孤零零一个 "/"）按普通消息处理
 * （返回 null）。指令名大小写敏感（/ADD 不是 /add）。
 */
export function parse(text: string): Invocation | null {
  const t = text.replace(/^[ \t]+/, '')
  if (!t.startsWith('/')) return null
  const body = t.slice(1)
  const m = /[ \t\n]/.exec(body)
  let name: string
  let rest: string
  if (m) {
    name = body.slice(0, m.index)
    rest = body.slice(m.index).replace(/^[ \t\n]+/, '')
  } else {
    name = body
    rest = ''
  }
  name = name.trim()
  if (!name) return null
  return { name, rest }
}

// ── 服务缝（注册表 + 机制函数 ②：Dispatch）───────────────────────────────
// 注册表用 Map 结构（约束：不用 if-else 链分派）；主名与别名同一命名空间。
// 本服务是纯内存机制，零 IO —— 无需 impl 层，由 plugins/command-bus 提供实例。
export class CommandService extends Service {
  /** 主名 → 实现。Map 保插入序，names() 按注册序返回。 */
  private readonly cmds = new Map<string, Command>()
  /** 别名 → 主名。 */
  private readonly aliases = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  /**
   * 注册一条指令。重名（主名或别名撞任何已有主名/别名）直接抛
   * CommandError('duplicate') —— 重名是编程错误，注册期就炸，不留到运行时。
   */
  register(cmd: Command): void {
    if (!cmd.name || !cmd.name.trim()) {
      throw new CommandError('duplicate', '指令名为空，拒绝注册')
    }
    if (!cmd.usage || !cmd.usage.trim()) {
      throw new CommandError('duplicate', `指令 /${cmd.name} 缺少 usage —— 每条指令必须带一行用法说明`)
    }
    if (!Number.isInteger(cmd.minArgs) || cmd.minArgs < 0) {
      throw new CommandError('duplicate', `指令 /${cmd.name} 的 minArgs 非法（${cmd.minArgs}）`)
    }
    if (cmd.maxArgs !== -1 && (!Number.isInteger(cmd.maxArgs) || cmd.maxArgs < cmd.minArgs)) {
      throw new CommandError('duplicate', `指令 /${cmd.name} 的 maxArgs 非法（${cmd.maxArgs}，需 ≥ minArgs 或 -1）`)
    }
    const clash = (n: string) => this.cmds.has(n) || this.aliases.has(n)
    if (clash(cmd.name)) {
      throw new CommandError('duplicate', `指令重名：/${cmd.name} 已注册`)
    }
    for (const a of cmd.aliases ?? []) {
      if (clash(a)) {
        throw new CommandError('duplicate', `指令 /${cmd.name} 的别名 ${a} 与已有指令冲突`)
      }
    }
    this.cmds.set(cmd.name, cmd)
    for (const a of cmd.aliases ?? []) this.aliases.set(a, cmd.name)
  }

  /** 按主名或别名取指令；未注册返回 undefined。 */
  use(name: string): Command | undefined {
    const main = this.aliases.get(name) ?? name
    return this.cmds.get(main)
  }

  /** 全部主名，按注册序（未知指令的可用清单与 /cur 共用这个顺序）。 */
  names(): string[] {
    return [...this.cmds.keys()]
  }

  /**
   * 全部已注册指令（含 usage / 参数上下限），按注册序。
   * 输入区 / 联想菜单的数据源：界面不该自己硬编码指令清单 —— 注册表是唯一出处。
   */
  list(): Command[] {
    return [...this.cmds.values()].map((c) => ({ ...c }))
  }

  /**
   * 机制函数 ②：Dispatch —— 分派执行一条解析好的指令。
   * 未注册 → CommandError('unknown') 且必带可用清单（不静默）；
   * 参数个数越界 → CommandError('bad_args') 且必带 usage。
   */
  async dispatch(base: CommandCtx, inv: Invocation): Promise<Reply> {
    const cmd = this.use(inv.name)
    if (!cmd) {
      const names = this.names()
      if (names.length === 0) {
        throw new CommandError('unknown', `未知指令 /${inv.name}（当前没有任何可用指令）`)
      }
      throw new CommandError('unknown', `未知指令 /${inv.name}（可用：${names.map((n) => `/${n}`).join(' ')}）`)
    }
    const args = inv.rest.trim().split(/\s+/).filter(Boolean)
    if (args.length < cmd.minArgs || (cmd.maxArgs !== -1 && args.length > cmd.maxArgs)) {
      const want =
        cmd.minArgs === cmd.maxArgs
          ? `${cmd.minArgs} 个参数`
          : cmd.maxArgs === -1
            ? `至少 ${cmd.minArgs} 个参数`
            : `${cmd.minArgs}~${cmd.maxArgs} 个参数`
      throw new CommandError('bad_args', `/${cmd.name} 需要${want}，实际 ${args.length} 个。用法：${cmd.usage}`)
    }
    const c: CommandCtx = {
      ...base,
      arg: inv.rest,
      args,
      raw: `/${inv.name}${inv.rest ? ` ${inv.rest}` : ''}`,
    }
    return cmd.run(c)
  }
}
