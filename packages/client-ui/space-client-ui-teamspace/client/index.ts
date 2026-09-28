// 团队空间整页（客户端）。
//
// 布局（用户拍板）：一屏定高——左「时间线」、右「轮次状态 + 成员」各自
// el-scrollbar 内部滚动（height 组件 prop，非内联样式），输入区固定底部；
// 时间线自动滚到最新一条。
// 视觉（大道至简 + 功能齐）：el-timeline（作者彩签 + 时间轴）承载事件流，
// el-descriptions 承载轮次状态，el-card 分区，快捷按钮直接发 /commit。
// 原语全部来自外壳全局注册的 element-plus / k-*，零样式文件、零内联样式。
//
// @ 提及：输入 @ 浮出候选（目标 agent + 人类，协调者不可被调用），点选插入
// @id；服务端把 @token 与在册成员精确匹配并随条目持久化（迁移 0005），
// /commit 合并进 events.mentions —— orchestrator 的 mentionHints 由此而来。
// 发送走 handleInbound（staging-commands 语义处理体），与 HTTP 入站同路径。
import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, resolveComponent, watch } from 'vue'
import { useRpc } from '@cordisjs/client'
import EventItem from 'space-client-ui-shared/client/EventItem.ts'
import { authorLabel, formatTime } from 'space-client-ui-shared/client/labels.ts'
import type { EventLite, MemberLite } from 'space-client-ui-shared/client/labels.ts'

interface SessionLite { id: string; title: string }
interface StagingEntry { id: string; seq: number; text: string; authorId: string }
interface TurnLite {
  state: string
  decisionCalls: number
  delegatedTargets: string[]
  stopReason: string
  stopDetail: string
}
type SendResult = { reply: string } | { error: string; detail: string }
interface CommandLite { name: string; usage: string; minArgs: number; maxArgs: number }
/** 联想菜单：null = 关闭；否则 slash（指令联想）或 mention（成员联想）。 */
type Menu = { kind: 'slash'; query: string } | { kind: 'mention'; query: string } | null

const STATE_LABEL: Record<string, string> = {
  chain: '进行中',
  static: '已暂停',
}
const STATE_TAG: Record<string, string> = { chain: 'warning', static: 'info' }
const STOP_LABEL: Record<string, string> = {
  await_human: '等待人类下一步指示',
  invalid_target: '委托目标不在授权名单',
  coordinator_unconfigured: '协调者未配置',
  coordinator_error: '协调者调用失败',
  coordinator_empty: '协调者空输出',
  duplicate_target: '同轮重复委托',
  '': '—',
}

/** 可被 @ 的角色（目标 agent + 人类）——协调者不在清单。 */
const MENTION_ROLES = new Set(['会议记录官', '挑战者', '需求分析师', 'DRI', '成员'])

/** 成员标签配色：DRI 绿（审批权），目标 agent 蓝，其他灰。 */
const roleTagType = (role: string) => (role === 'DRI' ? 'success' : MENTION_ROLES.has(role) ? 'primary' : 'info')

/** 中间/右列滚动区固定高：视口减去输入区/标题/外壳占位。 */
const PANE_HEIGHT = 'calc(100vh - 300px)'

const TeamspacePage = defineComponent({
  name: 'SpaceTeamspace',
  setup() {
    const rpc = useRpc<{
      sessions(): Promise<SessionLite[]>
      commands(): Promise<CommandLite[]>
      events(sessionId: string): Promise<EventLite[] | null>
      members(sessionId: string): Promise<MemberLite[] | null>
      staging(sessionId: string): Promise<StagingEntry[] | null>
      turn(sessionId: string): Promise<TurnLite>
      send(sessionId: string, authorId: string, text: string, mentions?: string[]): Promise<SendResult>
    }>()

    const sessions = ref([]) as { value: SessionLite[] }
    const members = ref([]) as { value: MemberLite[] }
    const events = ref([]) as { value: EventLite[] }
    const staging = ref([]) as { value: StagingEntry[] }
    const turn = ref(null) as { value: TurnLite | null }
    const activeId = ref('')
    const authorId = ref('u_dri')
    const draft = ref('')
    const reply = ref('')
    const replyOk = ref(true)
    const menu = ref(null) as { value: Menu }
    const activeIdx = ref(0)
    const inputEl = ref(null) as { value: HTMLElement | null }
    const commands = ref([]) as { value: CommandLite[] }
    const scrollbar = ref<{ setScrollTop: (v: number) => unknown } | null>(null)
    let timer: ReturnType<typeof setInterval> | undefined

    const mentionCandidates = () => members.value.filter((m) => MENTION_ROLES.has(m.role))

    // ── 联想菜单（业界惯例：输入 / 或 @ 时按当前 token 实时过滤）─────────
    //  / 联想：行首（或换行后）的 "/token" —— token 与指令名前缀匹配
    //  @ 联想：结尾的 "@token" —— token 与成员 id / 角色名子串匹配
    const slashRe = /(?:^|\n)\/([a-z]*)$/i
    const mentionRe = /@([\w\u4e00-\u9fa5-]*)$/
    function deriveMenu(text: string): Menu {
      const slash = slashRe.exec(text)
      if (slash) return { kind: 'slash', query: slash[1]!.toLowerCase() }
      const at = mentionRe.exec(text)
      if (at) return { kind: 'mention', query: at[1]!.toLowerCase() }
      return null
    }
    const slashItems = (q: string) => commands.value.filter((c) => c.name.startsWith(q))
    const mentionItems = (q: string) => mentionCandidates()
      .filter((m) => m.principalId.toLowerCase().includes(q) || m.role.toLowerCase().includes(q))

    const parseMentions = (): string[] => {
      const ids = mentionCandidates().map((m) => m.principalId)
      return [...new Set((draft.value.match(/@([^\s@]+)/g) ?? [])
        .map((t) => t.slice(1))
        .filter((t) => ids.includes(t)))]
    }

    async function load() {
      try {
        if (sessions.value.length === 0) sessions.value = await rpc.value.sessions()
        if (commands.value.length === 0) commands.value = await rpc.value.commands()
        if (!activeId.value && sessions.value.length > 0) activeId.value = sessions.value[0]!.id
        if (!activeId.value) return
        const [ev, mb, st, tn] = await Promise.all([
          rpc.value.events(activeId.value),
          rpc.value.members(activeId.value),
          rpc.value.staging(activeId.value),
          rpc.value.turn(activeId.value),
        ])
        if (ev) events.value = ev
        if (mb) members.value = mb
        if (st) staging.value = st
        turn.value = tn
        if (reply.value.startsWith('加载失败')) reply.value = ''
      } catch (e) {
        replyOk.value = false
        reply.value = `加载失败：${String((e as Error).message ?? e)}`
      }
    }

    function pick(id: string) {
      activeId.value = id
      events.value = []
      void load()
    }

    function onDraft(v: string) {
      draft.value = v
      menu.value = deriveMenu(v)
      activeIdx.value = 0
    }

    // ── 键盘导航（业界惯例）：↑↓ 换选中项，Enter/Tab 补全，Esc 关闭；
    //    菜单关闭时 Enter 直发、Shift+Enter 换行。
    function menuCount(): number {
      const m = menu.value
      if (!m) return 0
      return m.kind === 'slash' ? slashItems(m.query).length : mentionItems(m.query).length
    }
    function pickActive(): void {
      const m = menu.value
      if (!m) return
      if (m.kind === 'slash') {
        const c = slashItems(m.query)[activeIdx.value]
        if (c) pickCommand(c.name)
      } else {
        const mm = mentionItems(m.query)[activeIdx.value]
        if (mm) insertMention(mm.principalId)
      }
    }
    function onKeydown(e: KeyboardEvent): void {
      const n = menuCount()
      if (n > 0) {
        if (e.key === 'ArrowDown') { activeIdx.value = (activeIdx.value + 1) % n; e.preventDefault(); return }
        if (e.key === 'ArrowUp') { activeIdx.value = (activeIdx.value - 1 + n) % n; e.preventDefault(); return }
        if (e.key === 'Enter' || e.key === 'Tab') { pickActive(); e.preventDefault(); return }
        if (e.key === 'Escape') { menu.value = null; e.preventDefault(); return }
      }
      if (e.key === 'Enter' && !e.shiftKey) { void sendText(draft.value); e.preventDefault() }
    }
    // 失焦延迟关闭：给浮层里的点选留出 mouseup 时间
    function onBlur(): void {
      setTimeout(() => { if (menu.value && !menu.value) return; setTimeout(() => { menu.value = null }, 0) }, 150)
    }

    /** 点选指令联想：把行尾 "/token" 补全成 "/name "（有参指令留给用户填参数）。 */
    function pickCommand(name: string) {
      draft.value = draft.value.replace(slashRe, `/${name} `)
      menu.value = null
    }

    /** 点选成员联想：把结尾的 "@token" 替换成 "@id "。 */
    function insertMention(id: string) {
      draft.value = draft.value.replace(mentionRe, `@${id} `)
      menu.value = null
    }

    async function sendText(text: string) {
      if (!activeId.value || !text.trim() || !authorId.value) {
        replyOk.value = false
        reply.value = '先选会议、选作者、写点什么'
        return
      }
      try {
        const result: SendResult = await rpc.value.send(activeId.value, authorId.value, text, parseMentions())
        replyOk.value = 'reply' in result
        reply.value = 'reply' in result ? result.reply : `出错了（${result.error}）：${result.detail}`
        if ('reply' in result) draft.value = ''
        menu.value = null
        await load()
      } catch (e) {
        replyOk.value = false
        reply.value = `发送失败：${String((e as Error).message ?? e)}`
      }
    }

    // 时间线自动滚到底部
    watch(() => events.value.length, async () => {
      await nextTick()
      scrollbar.value?.setScrollTop(999999)
    })

    onMounted(() => {
      void load()
      timer = setInterval(() => void load(), 4000)
    })
    onUnmounted(() => clearInterval(timer))

    return () => {
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElScrollbar = resolveComponent('el-scrollbar') as unknown as string
      const ElPopover = resolveComponent('el-popover') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const KLayout = resolveComponent('k-layout') as unknown as string
      const ElTimeline = resolveComponent('el-timeline') as unknown as string
      const ElTimelineItem = resolveComponent('el-timeline-item') as unknown as string
      const ElDescriptions = resolveComponent('el-descriptions') as unknown as string
      const ElDescriptionsItem = resolveComponent('el-descriptions-item') as unknown as string

      const sessionSelect = () => h(ElSelect, {
        modelValue: activeId.value,
        'onUpdate:modelValue': pick,
        filterable: true,
        placeholder: '选择会议',
      }, {
        default: () => sessions.value.map((s) => h(ElOption, { key: s.id, label: `${s.title}（${s.id}）`, value: s.id })),
      })

      // ── 左：时间线卡（header = 会议选择；body = el-timeline 内部滚动）──
      const timelineCard = h(ElCard, { shadow: 'hover' }, {
        header: () => sessionSelect(),
        default: () => h(ElScrollbar, { height: PANE_HEIGHT, ref: scrollbar }, {
          default: () => events.value.length === 0
            ? [h(ElEmpty, { description: '还没有事件 —— 在下方输入区发言，/commit 提交后这里出现时间线' })]
            : [h(ElTimeline, {}, {
                default: () => events.value.map((ev) => h(ElTimelineItem, {
                  key: ev.id,
                  timestamp: formatTime(ev.ts),
                  placement: 'top',
                  type: ev.authorKind === 'human' ? 'primary' : ev.authorKind === 'agent' ? 'success' : 'info',
                  hollow: ev.authorKind !== 'human',
                }, { default: () => h(EventItem, { event: ev, members: members.value }) })),
              })],
        }),
      })

      // ── 右上：轮次状态（el-descriptions 一屏看清）────────────────────
      const t = turn.value
      const turnCard = h(ElCard, { shadow: 'hover' }, {
        header: () => [
          h(ElTag, { size: 'small', type: t ? (STATE_TAG[t.state] ?? 'info') : 'info' }, { default: () => t ? (STATE_LABEL[t.state] ?? t.state) : '无回合' }),
          ' 协作轮次',
        ],
        default: () => h(ElDescriptions, { column: 1, border: true, size: 'small' }, {
          default: () => [
            h(ElDescriptionsItem, { label: '暂停原因' }, { default: () => t ? (STOP_LABEL[t.stopReason] ?? (t.stopReason || "—")) : '—' }),
            h(ElDescriptionsItem, { label: '说明' }, { default: () => t?.stopDetail || '—' }),
            h(ElDescriptionsItem, { label: '协调者调用（本回合）' }, { default: () => String(t?.decisionCalls ?? 0) }),
            h(ElDescriptionsItem, { label: '本回合已委托' }, { default: () => t && t.delegatedTargets.length ? t.delegatedTargets.join('、') : '（无）' }),
          ],
        }),
      })

      // ── 右下：成员（可 @ 清单，角色配色）─────────────────────────────
      const memberTag = (m: MemberLite) =>
        h(ElTag, { key: m.principalId, size: 'small', type: roleTagType(m.role) }, { default: () => `${m.role}（${m.principalId}）` })
      const ElSpace = resolveComponent('el-space') as unknown as string
      const membersCard = h(ElCard, { shadow: 'hover' }, {
        header: () => '可 @ 的成员（协调者不可被调用）',
        default: () => mentionCandidates().length
          ? [h(ElSpace, { wrap: true, size: 8 }, { default: () => mentionCandidates().map(memberTag) })]
          : [h(ElEmpty, { description: '暂无在册成员', imageSize: 60 })],
      })

      // ── 联想菜单面板（/ 指令带 usage；@ 成员带角色）────────────────────
      // ── 联想浮层（el-popover 虚拟锚定输入框，placement top-start）──────
      // 菜单行 = 文本按钮：键盘选中项高亮（type primary），点选补全。
      const menuRow = (i: number, label: string, hint: string, onClick: () => void) =>
        h('div', { key: `${i}-${label}` }, h(ElButton, {
          text: true, type: i === activeIdx.value ? 'primary' : 'info', onClick,
        }, { default: () => [h('b', label), `　${hint}`] }))
      const menuContent = () => {
        const m = menu.value
        if (!m) return null
        if (m.kind === 'slash') {
          const items = slashItems(m.query)
          return items.length === 0
            ? [h('div', '（没有匹配的指令）')]
            : items.map((c, i) => menuRow(i, `/${c.name}`, c.usage, () => pickCommand(c.name)))
        }
        const items = mentionItems(m.query)
        return items.length === 0
          ? [h('div', '（没有匹配的成员）')]
          : items.map((mm, i) => menuRow(i, `${mm.role}（${mm.principalId}）`, '插入提及', () => insertMention(mm.principalId)))
      }
      const suggestionPopover = () => h(ElPopover, {
        visible: menu.value !== null,
        'virtual-triggering': true,
        'virtual-ref': inputEl.value,
        placement: 'top-start',
        width: 560,
      }, { default: menuContent })

      const stagingLine = (e: StagingEntry) => h(ElTag, {
        key: e.id, size: 'large', type: 'info',
        closable: e.authorId === authorId.value, // 只有作者能撤自己的条目（服务端 /del 再校验一次）
        onClose: () => void sendText(`/del ${e.seq}`),
      }, { default: () => `#${e.seq} ${authorLabel(e.authorId, members.value)}：${e.text}` })
      const composer = h(ElCard, { shadow: 'hover' }, {
        header: () => '输入区 —— Enter 发送 / Shift+Enter 换行；/ 指令联想；@ 成员联想',
        default: () => [
          suggestionPopover(),
          h(ElRow, { gutter: 8, align: 'middle' }, {
            default: () => [
              h(ElCol, { span: 8 }, {
                default: () => h(ElSelect, {
                  modelValue: authorId.value,
                  'onUpdate:modelValue': (v: string) => { authorId.value = v },
                  placeholder: '我是谁（调试期自报）',
                }, {
                  default: () => members.value.filter((m) => m.role === 'DRI' || m.role === '成员')
                    .map((m) => h(ElOption, { key: m.principalId, label: `${m.role}（${m.principalId}）`, value: m.principalId })),
                }),
              }),
              h(ElCol, { span: 16 }, {
                default: () => h(ElRow, { justify: 'end' }, {
                  default: () => [
                    h(ElButton, { type: 'success', plain: true, onClick: () => void sendText('/commit') }, { default: () => '/commit 提交暂存' }),
                    h(ElButton, { type: 'primary', onClick: () => void sendText(draft.value) }, { default: () => '发送' }),
                  ],
                }),
              }),
            ],
          }),
          h(ElInput, {
            modelValue: draft.value,
            'onUpdate:modelValue': onDraft,
            onKeydown,
            onBlur,
            ref: (inst) => { inputEl.value = (inst as { textarea?: HTMLElement } | null)?.textarea ?? null },
            type: 'textarea',
            rows: 3,
            placeholder: '输入发言…（/ 指令联想；@ 提及成员；Enter 发送，Shift+Enter 换行）',
          }),
          reply.value ? h(ElAlert, {
            title: reply.value, type: replyOk.value ? 'success' : 'error', closable: true,
            onClose: () => { reply.value = '' },
          }) : null,
          staging.value.length === 0
            ? h('span', '暂存区为空 —— 普通文本自动入暂存（不触发协调者），/commit 才提交')
            : [h(ElSpace, { wrap: true, size: 8 }, { default: () => staging.value.map(stagingLine) })],
        ],
      })

      // 根布局（官方 home/settings 同款：页面自己渲染 k-layout）：
      //   k-layout（外壳负责顶栏标题/菜单/主体全屏 flex）
      //   └ div.content-area（占满 main-content：flex column）
      //      ├ el-scrollbar.content-body（flex:1，内部滚动 —— 时间线再长不撑爆页面）
      //      │   └ el-row（列宽响应式：宽屏 16/8 双栏，窄屏 xs=24 自动叠单列）
      //      └ 输入区（滚动区之外，自然固定在底部）
      // ⚠ 两件实测踩过的坑：①页面根不能用 k-content（max-width 55rem 居中，
      //   那是设置文档页容器）；②不渲染 k-layout 的话页面直接裸在顶层，
      //   没有顶栏也不占导航右侧区域。
      return h(KLayout, { main: 'page-teamspace' }, {
        default: () => h('div', { class: 'content-area' }, [
          h(ElScrollbar, { class: 'content-body' }, {
            default: () => h(ElRow, { gutter: 16 }, {
              default: () => [
                h(ElCol, { xs: 24, md: 16 }, { default: () => timelineCard }),
                h(ElCol, { xs: 24, md: 8 }, { default: () => [turnCard, membersCard] }),
              ],
            }),
          }),
          composer,
        ]),
      })
    }
  },
})

// ── 页面注册（官方约定）─────────────────────────────────────────────────
// 页面出现在外壳菜单/路由靠 client 插件自调 client.router.page（logger-webui
// dist 原文同款）；entry 的 routes 选项只影响服务端 SPA 404/加载态判定。
// ⚠ 不能注册在 '/'：外壳自带 home 页先占了 '/'（@cordisjs/client/app/home），
// 路由按注册顺序先匹配先赢 —— 用真实路径 '/teamspace'（同官方 '/logs'）。
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; icon?: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/teamspace',
    name: '团队空间',
    icon: 'activity:default',
    order: 900,
    component: TeamspacePage,
  })
}
