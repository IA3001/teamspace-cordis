// seam/space-settings —— 运行时键值设置缝（2026-10-05 新增）。
//
// 背景：cordis 面板的原生配置表单对本地 ts 条目渲染不出来（插件页显示
// 「此插件尚未安装」），模型接入等配置必须有自己的可持久化、面板可改的
// 通道。本缝提供**极小的同步 KV**：
//
//   · 值是任意 JSON（实现按 JSON.stringify/parse 落库）。
//   · get 同步 —— 实现是进程内 sqlite（DatabaseSync），调用方（L0 模型层
//     的 resolve()）在热路径上用得起。
//   · set 同步写 + 不广播（设置不是协作事件，不进时间线）。
//
// 键的命名约定（点分层级，谁消费谁定义）：
//   llm.apiKey / llm.baseURL / llm.model / llm.timeoutMs     —— space-llm-openai
//   embed.apiKey / embed.baseURL / embed.model               —— space-embedding-openai
//
// 依赖方向：impl 只准依赖 seams；消费方（impl/插件）只依赖本缝词汇。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    settings: SettingsService
  }
}

export class SettingsService extends Service {
  constructor(ctx: Context) {
    // 服务名必须显式给（cordis Service 构造签名 (ctx, name)）——漏了名字
    // 服务就提供不到 ctx.settings，strict inject 会把消费插件整批跳过。
    super(ctx, 'settings')
  }

  /** 读一个键；缺失返回 fallback。值不是合法 JSON 时也返回 fallback（不抛）。 */
  get<T>(key: string, fallback: T): T {
    throw new Error('space-settings: 实现未挂载')
  }

  /** 写一个键（JSON 落库）。value 传 undefined 等价删除该键。 */
  set(key: string, value: unknown): void {
    throw new Error('space-settings: 实现未挂载')
  }

  /** 全量快照（设置页展示用）；prefix 给定则只取该前缀的键（含点）。 */
  all(prefix?: string): Record<string, unknown> {
    throw new Error('space-settings: 实现未挂载')
  }
}
