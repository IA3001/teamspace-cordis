// 第一个业务插件（试金石）——写法就是 cordis 的标准插件形态。
//
// 官方插件三形态（核实日期 2026-09-26）：
//   1. 函数：导出 apply(ctx, config)
//   2. 对象：导出 { name, apply(ctx, config) }
//   3. 类：  export default class X extends Service { constructor(ctx) { super(ctx, 'x') } }
// 来源：https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/01-first-plugin
//
// 本插件的存在意义：证明「加功能 = 加一个插件文件 + 在 cordis.yml 里加一项」。
// 注意这里没有一行框架启动代码 —— 插件只描述自己的贡献。
import type { Context } from 'cordis'

export const name = 'app'

/** 配置由 cordis.yml 中该项的 config 字段传入。 */
export interface Config {
  greeting: string
}

export function apply(ctx: Context, config: Config) {
  // 用 console.log 而不是 ctx.logger：当前这套 cordis RC 组合下
  // ctx.logger 没有可用的控制台导出器，会静默吞掉。详见 cordis.yml 注释。
  console.log(`[plugin:${name}] ${config.greeting}`)
}