# 公共接口示例

只验证可编译和源码声明一致，行为由工具与消费者测试负责。

```ts type-equiv:ToolInvoker
/** 调用者身份（审计与闸门的主体）。*/
interface ToolInvoker {
  /** 调用者 principal id（u_* / a_*）。 */
  id: string
  /** 调用发生的会话（全局工具可空）。 */
  sessionId?: string
  /** Abort long-running work when the owning Agent run is invalidated. */
  signal?: AbortSignal
}
```

```ts type-equiv:ToolResult
/** 一次工具调用的结果。*/
interface ToolResult {
  toolId: string
  ok: boolean
  /** 成功 = 输出文本；失败 = 人类可读错误（错误码在 code）。 */
  output: string
  code?: string
  /** 耗时毫秒（可观测）。 */
  costMs: number
}
```

```ts compile
import type { ToolInvoker, ToolResult } from "../../packages/seam/space-tool/src/index.ts"
const invoker: ToolInvoker = { id: "a_example" }
const result: ToolResult = { toolId: "example", ok: true, output: invoker.id, costMs: 0 }
void result
```
