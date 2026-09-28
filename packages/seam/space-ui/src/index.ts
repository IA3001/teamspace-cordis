// seam/space-ui —— 能力缝。
//
// 这一层**只有词汇**：Service 声明 + 类型 + 错误分类法。零实现、零 IO。
// 实现放 packages/impl/，策略放 packages/policy/；两处都只能依赖本包。
// 依赖方向由 scripts/lint-deps.sh 强制（依据 dev-cordis/MODULE-PLAN.md 第 3.7 节 / 断言 ①②）。
//
// 词汇（承旧 elements/ui/，P4 2026-09-28 补真）：
//   Panel{key, slot, title, order} + 槽位常量 right / bottom / composer
//   约定：后端只给 key，前端按 key 找组件，未知 key 降级占位（承旧口径）。
//
// 与 webui 页面的关系：webui 的 page/entry 是「整页」单位（菜单项），
// 本缝的 Panel 是「页内区域」单位（slot 槽位）—— P4 先把各区域包的 Panel
// 描述符登记进注册表（可查询、可断言），P5 组合面（surface/layout）按
// slot 取 Panel 拼装整页。重复 key 是编程错误 → 注册即炸（断言 ⑥ 口径）。
import { Service } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    ui: UIService
  }
}

// ── 槽位词汇 ──────────────────────────────────────────────────────────────

/** 页内区域槽位（承旧 elements/ui 的槽位常量）。 */
export type PanelSlot = 'right' | 'bottom' | 'composer'

export const PANEL_SLOTS: readonly PanelSlot[] = ['right', 'bottom', 'composer']

// ── 数据形状 ──────────────────────────────────────────────────────────────

/** 一个页内区域描述符。前端按 key 找组件；未知 key 降级占位。 */
export interface Panel {
  /** 幂等键（注册表主键），如 'space.timeline'。 */
  key: string
  slot: PanelSlot
  /** 给人看的区域名。 */
  title: string
  /** 同槽位内的排序（小在前；缺省 0）。 */
  order?: number
}

// ── 错误分类法（规律 3：实现与策略不得自造错误串，只能抛这里的错误码）──────

export type UIErrorCode =
  /** Panel key 重复 —— 重名是编程错误，注册期就炸（断言 ⑥ 口径）。 */
  | 'duplicate_panel'
  | 'not_found'
  /** slot 不在三个槽位常量里。 */
  | 'invalid_slot'

export class UIError extends Error {
  constructor(
    public readonly code: UIErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'UIError'
  }
}

// ── 服务缝 ────────────────────────────────────────────────────────────────
// 实现层必须保证的语义：
//   · registerPanel：key 重复 → duplicate_panel 即炸；slot 非法 → invalid_slot
//   · listPanels(slot?)：按 (slot, order, key) 稳定排序
export abstract class UIService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  /** 登记一个页内区域描述符。key 重复即炸。 */
  abstract registerPanel(panel: Panel): void

  /** 全部（或指定槽位的）Panel，按 (slot, order, key) 稳定排序。 */
  abstract listPanels(slot?: PanelSlot): Panel[]
}
