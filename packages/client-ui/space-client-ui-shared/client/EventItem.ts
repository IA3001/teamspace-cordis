// EventItem —— 一条事件的内容视图（shared：时间线的条目内容，只此一份）。
// 外层的 el-timeline-item（时间轴点/线/时间戳）由页面提供；这里只管
// 「谁说的 + 说了什么」：作者彩签（human 蓝 / agent 绿 / system 灰）+ 正文。
// 组件原语只用外壳全局注册的 el-tag（铁律 1 选型表）。
import { defineComponent, h, resolveComponent } from 'vue'
import type { PropType, VNode } from 'vue'
import { authorLabel } from './labels'
import type { EventLite, MemberLite } from './labels'

export default defineComponent({
  name: 'SpaceEventItem',
  props: {
    event: { type: Object as PropType<EventLite>, required: true },
    members: { type: Array as PropType<MemberLite[]>, default: () => [] },
  },
  setup(props) {
    return () => {
      const ElTag = resolveComponent('el-tag') as unknown as string
      const kind = props.event.authorKind
      const type = kind === 'human' ? 'primary' : kind === 'agent' ? 'success' : 'info'
      const children: VNode[] = [
        h(ElTag, { size: 'small', type }, { default: () => authorLabel(props.event.authorId, props.members) }),
      ]
      if (props.event.kind !== 'message') {
        // 非 message 事件（未来 toolcall 等）：kind 标注，未知形状不炸，降级占位
        children.push(h(ElTag, { size: 'small', type: 'warning' }, { default: () => props.event.kind }))
      }
      children.push(h('span', ` ${props.event.text}`))
      return h('div', children)
    }
  },
})
