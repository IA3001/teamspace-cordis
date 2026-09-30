// 左侧会话栏（客户端）—— 2026-09-29 改版的新增区；P8 起新会议带角色选择。
//
// 结构（用户拍板）：置顶「新会议」主动作（P8：按钮下方一行 coding 角色多选，
// el-select multiple 标准件，缺省不选 = 只开纯会议名册）→ 会话列表按状态分组
// （进行中 / 已结束，数据来自 session.status）→ 底部当前身份（DRI）。窄视口
// 默认收起的开关在中央顶栏（页面侧持有），本组件只负责内容。
//
// 选中态走 URL：?session=<id>（useRouter.replace 写、useRoute 读）——页面与
// 本组件分属两个 entry（各自的 Vite 产物、各自的空间），URL 是唯一不需要
// 跨包共享状态的同步点（外壳 router 服务是单例，经 @cordisjs/client 外部化
// 共享）。
//
// 铁律 1：组件只用外壳全局注册的 el-* / k-*（零 import element-plus），
// 零样式文件、零内联样式、零令牌定义。
import { computed, defineComponent, h, onMounted, onUnmounted, ref, resolveComponent } from 'vue'
import { useRoute, useRouter, useRpc } from '@cordisjs/client'

/** 会话的客户端视图（列表需要的列；形状 = seam Session 的子集）。 */
interface SessionRow {
  id: string
  title: string
  status: string
  updatedAt: string
}

/** 成员的客户端视图（身份展示需要的列）。 */
interface MemberRow {
  principalId: string
  role: string
}

/** coding 名册条目（新会议「附加角色」多选的数据源）。 */
interface RosterRow {
  id: string
  title: string
}

/** 最近更新在前（同组内排序）。 */
const byUpdatedDesc = (a: SessionRow, b: SessionRow) => b.updatedAt.localeCompare(a.updatedAt)

const SessionsRail = defineComponent({
  name: 'SpaceSessionsRail',
  setup() {
    const rpc = useRpc<{
      sessions(): Promise<SessionRow[]>
      members(sessionId: string): Promise<MemberRow[] | null>
      codingRoster(): Promise<RosterRow[]>
      create(selectedIds: string[]): Promise<SessionRow>
    }>()
    const router = useRouter()
    const route = useRoute()

    const sessions = ref([]) as { value: SessionRow[] }
    const members = ref([]) as { value: MemberRow[] }
    const roster = ref([]) as { value: RosterRow[] }
    const selected = ref([]) as { value: string[] }
    const creating = ref(false)
    const error = ref('')
    let timer: ReturnType<typeof setInterval> | undefined

    /** 当前选中会话 = URL 上的 ?session=（页面负责在缺省时写入首个会话）。 */
    const activeId = computed(() => route.query.session ?? '')
    const openOnes = computed(() => sessions.value.filter((s) => s.status !== 'closed').sort(byUpdatedDesc))
    const closedOnes = computed(() => sessions.value.filter((s) => s.status === 'closed').sort(byUpdatedDesc))
    /** 当前身份：所选会话的 DRI（成员表缺 DRI 时降级为调试期约定身份 u_dri）。 */
    const identity = computed(() => {
      const dri = members.value.find((m) => m.role === 'DRI')
      return `DRI（${dri?.principalId ?? 'u_dri'}）`
    })

    async function load() {
      try {
        sessions.value = await rpc.value.sessions()
        if (activeId.value) {
          const mb = await rpc.value.members(activeId.value)
          if (mb) members.value = mb
        }
        error.value = ''
      } catch (e) {
        error.value = `会话栏加载失败：${String((e as Error).message ?? e)}`
      }
    }

    /** coding 名册只拉一次（stub 名册静态；插件启停后刷新页面即新）。 */
    async function loadRoster() {
      try {
        roster.value = await rpc.value.codingRoster()
      } catch {
        roster.value = [] // 名册取不到 = 不展示多选（纯会议照常可开）
      }
    }

    function select(id: string) {
      void router.replace({ query: { session: id } })
    }

    async function create() {
      creating.value = true
      try {
        const s = await rpc.value.create([...selected.value])
        selected.value = []
        await load()
        select(s.id)
      } catch (e) {
        error.value = `新建会议失败：${String((e as Error).message ?? e)}`
      } finally {
        creating.value = false
      }
    }

    onMounted(() => {
      void load()
      void loadRoster()
      timer = setInterval(() => void load(), 5000)
    })
    onUnmounted(() => clearInterval(timer))

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElDivider = resolveComponent('el-divider') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string

      /** 会话条目：文本按钮，选中高亮（active 由 URL 派生）。 */
      const sessionItem = (s: SessionRow) => h(ElButton, {
        key: s.id,
        text: true,
        type: s.id === activeId.value ? 'primary' : 'info',
        onClick: () => select(s.id),
      }, { default: () => s.title })

      /** 状态分组：分组头用 el-divider（content-position left），条目纵向排列。 */
      const group = (label: string, list: SessionRow[]) => [
        h(ElDivider, { contentPosition: 'left' }, { default: () => label }),
        list.map(sessionItem),
      ]

      const content = () => {
        if (sessions.value.length === 0) {
          return [h(ElEmpty, { description: '暂无会议 —— 点上方「新会议」开始', imageSize: 60 })]
        }
        return [
          ...(openOnes.value.length ? group('进行中', openOnes.value) : []),
          ...(closedOnes.value.length ? group('已结束', closedOnes.value) : []),
        ]
      }

      /** 新会议主动作（P8）：按钮 + coding 角色多选（名册为空则不展示多选）。 */
      const header = () => h(ElSpace, { direction: 'vertical', fill: true }, {
        default: () => [
          h(ElButton, {
            type: 'primary',
            disabled: creating.value,
            onClick: () => void create(),
          }, { default: () => creating.value ? '创建中…' : '新会议' }),
          ...(roster.value.length ? [h(ElSelect, {
            multiple: true,
            collapseTags: true,
            collapseTagsTooltip: true,
            clearable: true,
            placeholder: '附加 coding 角色（可多选）',
            modelValue: selected.value,
            'onUpdate:modelValue': (v: string[]) => { selected.value = v },
          }, { default: () => roster.value.map((a) => h(ElOption, {
            key: a.id,
            label: a.title,
            value: a.id,
          })) })] : []),
        ],
      })

      return [
        error.value
          ? h(ElAlert, { title: error.value, type: 'error', closable: true, onClose: () => { error.value = '' } })
          : null,
        h('div', { class: 'page-sidebar-header' }, [header()]),
        h('div', { class: 'page-sidebar-content' }, content()),
        h('div', [
          h(ElDivider),
          h(ElSpace, { size: 8 }, {
            default: () => [
              h(ElText, { size: 'small', type: 'info' }, { default: () => '当前身份' }),
              h(ElTag, { size: 'small', type: 'success' }, { default: () => identity.value }),
            ],
          }),
        ]),
      ]
    }
  },
})

/** 本包 client 插件：把会话栏挂到整页预留的槽位（外壳原生跨 entry 通道）。 */
interface RailCtx {
  client: {
    router: {
      slot(options: { type: string; component: unknown; order?: number }): void
    }
  }
}

export default function main(ctx: RailCtx) {
  ctx.client.router.slot({ type: 'space-teamspace-sidebar', component: SessionsRail, order: 0 })
}
