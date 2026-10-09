// EventItem —— 一条事件的内容视图（shared：时间线的条目内容，只此一份）。
// 外层的 el-timeline-item（时间轴点/线/时间戳）由页面提供；这里只管
// 「谁说的 + 说了什么」：作者彩签（human 蓝 / agent 绿 / system 灰）+ 正文
// + 复制按钮（UX 评审第 13 条：长文本一键复制，成功后短暂反馈）。
// 组件原语只用外壳全局注册的 el-tag / el-button（铁律 1 选型表）。
import { defineComponent, h, ref, resolveComponent } from 'vue'
import type { PropType, VNode } from 'vue'
import { authorLabel } from './labels'
import type { EventLite, MemberLite } from './labels'
import { renderMarkdown } from './md'

export default defineComponent({
  name: 'SpaceEventItem',
  props: {
    event: { type: Object as PropType<EventLite>, required: true },
    members: { type: Array as PropType<MemberLite[]>, default: () => [] },
  },
  setup(props) {
    /** 复制反馈：true = 刚复制成功（按钮短暂变「已复制」）。 */
    const copied = ref(false)
    function copy() {
      const text = props.event.text
      void navigator.clipboard?.writeText(text).then(() => {
        copied.value = true
        setTimeout(() => { copied.value = false }, 1500)
      })
    }
    return () => {
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const kind = props.event.authorKind
      const type = kind === 'human' ? 'primary' : kind === 'agent' ? 'success' : 'info'
      const children: VNode[] = [
        h(ElTag, { size: 'small', type }, { default: () => authorLabel(props.event.authorId, props.members) }),
      ]
      if (props.event.kind !== 'message') {
        // 非 message 事件（未来 toolcall 等）：kind 标注，未知形状不炸，降级占位
        children.push(h(ElTag, { size: 'small', type: 'warning' }, { default: () => props.event.kind }))
      }
      if (kind === 'agent' && props.event.kind === 'message') {
        // agent 正文：轻量 Markdown 渲染（代码块/行内代码/粗体/链接；全部 h() 分词，无 v-html）
        children.push(h('span', renderMarkdown(props.event.text, h, { ElText })))
      } else if (kind === 'human') {
        // human：纯文本（@高亮等由外层页面处理，此处保持原样）
        children.push(h('span', ` ${props.event.text}`))
      } else {
        // system：斜体语义（em 标签，非样式）
        children.push(h('span', ' '), h('em', props.event.text))
      }
      children.push(h(ElButton, {
        text: true, size: 'small', onClick: copy,
      }, { default: () => (copied.value ? '已复制' : '复制') }))
      return h('div', children)
    }
  },
})
