// IconBtn —— 无边框小图标按钮（shared：暂存条目 × / 回执关闭，只此一份）。
//
// 为什么不用 el-tag 的内置 close（2026-09-29 回炉）：内置 close 图标的命中
// 目标是内部 SVG，click hit-target 有歧义（实测三次精确点击零反应），且无法
// 从外部补 aria-label。这里用 el-button(text) + 外壳 k-icon 组合：点击路径
// 是标准按钮，aria-label / title 直接可标。
// 组件原语只用外壳全局注册的 el-button / k-icon（铁律 1 选型表）。
import { defineComponent, h, resolveComponent } from 'vue'

export default defineComponent({
  name: 'SpaceIconBtn',
  props: {
    /** 外壳 k-icon 名，如 'times-full'。 */
    icon: { type: String, required: true },
    /** aria-label（读屏可见；同时作 title 悬停提示）。 */
    label: { type: String, required: true },
  },
  emits: ['press'],
  setup(props, { emit }) {
    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const KIcon = resolveComponent('k-icon') as unknown as string
      return h(ElButton, {
        text: true,
        size: 'small',
        'aria-label': props.label,
        title: props.label,
        onClick: () => emit('press'),
      }, { default: () => h(KIcon, { name: props.icon }) })
    }
  },
})
