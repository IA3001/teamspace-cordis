import { computed, defineComponent, h, ref, resolveComponent } from 'vue'
import type { Component } from 'vue'
import * as ElementIcons from '@element-plus/icons-vue'

const ICONS = ElementIcons as unknown as Record<string, Component>
export const SVG_ICON_NAMES = Object.keys(ICONS).filter((name) => /^[A-Z][A-Za-z0-9]+$/u.test(name)).sort()
export const DEFAULT_AGENT_ICON = 'UserFilled'

export function svgIconComponent(name: string): Component {
  return ICONS[name] ?? ICONS[DEFAULT_AGENT_ICON]!
}

export const SvgIcon = defineComponent({
  name: 'SpSvgIcon',
  props: { name: { type: String, default: DEFAULT_AGENT_ICON } },
  setup(props) {
    return () => h(svgIconComponent(props.name), { class: 'sp-svg-icon', 'aria-hidden': 'true' })
  },
})

/** Searchable picker backed by the full Element Plus SVG icon library. */
export const SvgIconPicker = defineComponent({
  name: 'SpSvgIconPicker',
  props: {
    modelValue: { type: String, default: DEFAULT_AGENT_ICON },
    buttonText: { type: String, default: '选择图标' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const open = ref(false)
    const query = ref('')
    const visibleNames = computed(() => {
      const needle = query.value.trim().toLocaleLowerCase()
      return needle ? SVG_ICON_NAMES.filter((name) => name.toLocaleLowerCase().includes(needle)) : SVG_ICON_NAMES
    })

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      return h('span', { class: 'sp-svg-icon-picker' }, [
        h(ElButton, {
          text: true, disabled: props.disabled, onClick: () => { open.value = true },
          'aria-label': props.buttonText,
        }, { default: () => [h(SvgIcon, { name: props.modelValue }), h('span', props.buttonText)] }),
        h(ElDialog, {
          modelValue: open.value, title: '选择 SVG 图标', width: 'min(760px, 92vw)', appendToBody: true,
          'onUpdate:modelValue': (value: boolean) => { open.value = value },
        }, {
          default: () => [
            h(ElInput, { modelValue: query.value, clearable: true, placeholder: `搜索图标（${SVG_ICON_NAMES.length} 个）`,
              'onUpdate:modelValue': (value: string) => { query.value = value } }),
            h(ElScrollbar, { class: 'sp-svg-icon-gallery-scroll', height: 'min(56vh, 520px)' }, {
              default: () => h('div', { class: 'sp-svg-icon-gallery' }, visibleNames.value.map((name) => h(ElButton, {
                key: name, class: 'sp-svg-icon-choice', type: name === props.modelValue ? 'primary' : undefined,
                plain: name !== props.modelValue, onClick: () => { emit('update:modelValue', name); open.value = false },
                title: name, 'aria-label': name,
              }, { default: () => [h(SvgIcon, { name }), h('span', name)] }))),
            }),
          ],
        }),
      ])
    }
  },
})
