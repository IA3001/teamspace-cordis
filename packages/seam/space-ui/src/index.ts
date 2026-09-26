// seam/space-ui —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 elements/ui/）：
//   Panel{Key, Slot, Title, Props} + ManifestItem
//   槽位常量 right / bottom / composer
//   约定：后端只给 Key，前端按 key 找组件，未知 key 降级占位
//
// P0 阶段：只立 Service 声明，零业务。真能力在 P4。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    ui: UIService
  }
}

export class UIService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ui')
  }
}