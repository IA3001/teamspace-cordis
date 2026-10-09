// Agent 配置页（客户端）—— 2026-10-05 新增，挂在 5172 调试控制台。
//
// 结构：onMounted 先 me(token) —— 未登录 → 就地 Admin 登录卡片（承
// admin / models 包同款）；管理员 →
//   ① 名册表（id/标题/类别/能力/状态/promptRef + 每行「改提示词」弹窗）
//   ② 自治预算（el-input-number + 保存，即改即用）
//   ③ 提示词模板列表（选中 → ref/标题/正文编辑 → upsert）
//
// 铁律 1：只用外壳全局注册的 el-*（resolveComponent），零 import
// element-plus、零手写样式（复用 sp-admin-wrap / sp-setting-* 类）。
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRpc, useRoute } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, status, section, field, actionsRow, note, loginGate } from 'space-client-ui-shared/client/console.ts'

/** getConfig 的返回形状（服务端逐字段对齐）。 */
interface RosterRow {
  id: string
  kind: 'meeting' | 'coding'
  title: string
  capabilities: string[]
  promptRef: string
  status: string
  promptOverride: string
  roleLabel?: string
}
interface PromptRow {
  ref: string
  title: string
  body: string
  updatedAt: string
}
interface ConfigShape {
  roster: RosterRow[]
  prompts: PromptRow[]
  budget: number
  llmConfigured: boolean
}
interface OpResult { ok?: boolean; detail?: string; error?: string }

const TOKEN_KEY = 'admin_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

const AgentsPage = defineComponent({
  name: 'SpaceAgentsPage',
  setup() {
    const route = useRoute()

    const loginName = ref('')
    const loginPass = ref('')
    const loginErr = ref('')
    const loginBusy = ref(false)
    async function doAdminLogin() {
      loginBusy.value = true
      loginErr.value = ''
      const r = await rpc.value.login(loginName.value, loginPass.value)
      loginBusy.value = false
      if ('error' in r) { loginErr.value = r.detail ?? r.error; return }
      localStorage.setItem(TOKEN_KEY, r.token)
      window.location.reload()
    }

    const rpc = useRpc<{
      me(token: string): Promise<{ id: string; username: string } | null>
      getConfig(token: string): Promise<ConfigShape | null>
      savePrompt(token: string, ref: string, title: string, body: string): Promise<OpResult | null>
      saveAgentPrompt(token: string, agentId: string, promptRef: string): Promise<OpResult | null>
      saveBudget(token: string, budget: number): Promise<OpResult | null>
      createAgent(token: string, cfg: { title: string; roleLabel?: string; promptRef?: string }): Promise<OpResult | null>
      removeAgent(token: string, id: string): Promise<OpResult | null>
      login(username: string, password: string): Promise<{ token: string } | { error: string; detail?: string }>
    }>()

    const me = ref<{ id: string; username: string } | null | undefined>(null)
    const cfg = ref<ConfigShape | null>(null)
    const msg = ref('')
    const msgOk = ref(true)
    const busy = ref(false)

    // 自治预算草稿。
    const budget = ref(0)
    // 新建 Agent 弹窗（①）。
    const naVisible = ref(false)
    const naTitle = ref('')
    const naDuty = ref('')
    const naPromptRef = ref('')
    const naBusy = ref(false)
    async function doCreateAgent() {
      naBusy.value = true
      try {
        const r = await rpc.value.createAgent(getToken(), { title: naTitle.value, roleLabel: naDuty.value, promptRef: naPromptRef.value })
        if (r?.ok) { naVisible.value = false; naTitle.value = ''; naPromptRef.value = ''; await refresh(); flash(true, r.detail ?? '已创建') }
        else flash(false, r?.detail ?? r?.error ?? '创建失败')
      } finally { naBusy.value = false }
    }
    async function doRemoveAgent(row: RosterRow) {
      busy.value = true
      try {
        const r = await rpc.value.removeAgent(getToken(), row.id)
        if (r?.ok) { await refresh(); flash(true, r.detail ?? '已删除') }
        else flash(false, r?.detail ?? r?.error ?? '删除失败')
      } finally { busy.value = false }
    }

    // per-agent 重定向弹窗状态。
    const paVisible = ref(false)
    const paAgent = ref<RosterRow | null>(null)
    const paRef = ref('')
    // 提示词编辑状态（选中 ref + 三字段草稿）。
    const selRef = ref('')
    const edTitle = ref('')
    const edBody = ref('')

    function flash(ok: boolean, text: string) {
      msgOk.value = ok
      msg.value = text
    }

    async function refresh() {
      const c = await rpc.value.getConfig(getToken())
      if (!c) return
      cfg.value = c
      budget.value = c.budget
      // 未选中或选中项已被删 → 自动选第一条。
      if (!selRef.value || !c.prompts.some((p) => p.ref === selRef.value)) {
        pick(c.prompts[0]?.ref ?? '')
      }
    }

    function pick(ref: string) {
      selRef.value = ref
      const p = cfg.value?.prompts.find((x) => x.ref === ref)
      edTitle.value = p?.title ?? ''
      edBody.value = p?.body ?? ''
    }

    onMounted(async () => {
      const m = await rpc.value.me(getToken())
      if (!m) { me.value = undefined; return }
      me.value = m
      await refresh()
    })

    async function doSaveBudget() {
      busy.value = true
      try {
        const r = await rpc.value.saveBudget(getToken(), Number(budget.value) || 0)
        if (r?.ok) { await refresh(); flash(true, r.detail ?? '已保存') }
        else flash(false, r?.detail ?? r?.error ?? '保存失败')
      } finally { busy.value = false }
    }

    async function doSavePrompt() {
      busy.value = true
      try {
        const r = await rpc.value.savePrompt(getToken(), selRef.value, edTitle.value, edBody.value)
        if (r?.ok) { await refresh(); flash(true, r.detail ?? '已保存') }
        else flash(false, r?.detail ?? r?.error ?? '保存失败')
      } finally { busy.value = false }
    }

    async function doSaveAgentPrompt() {
      if (!paAgent.value) return
      busy.value = true
      try {
        const r = await rpc.value.saveAgentPrompt(getToken(), paAgent.value.id, paRef.value)
        if (r?.ok) { paVisible.value = false; await refresh(); flash(true, r.detail ?? '已保存') }
        else flash(false, r?.detail ?? r?.error ?? '保存失败')
      } finally { busy.value = false }
    }

    return () => {
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElInputNumber = resolveComponent('el-input-number') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const ElTag = resolveComponent('el-tag') as unknown as string
      const ElTable = resolveComponent('el-table') as unknown as string
      const ElTableColumn = resolveComponent('el-table-column') as unknown as string
      const ElDialog = resolveComponent('el-dialog') as unknown as string
      const ElSelect = resolveComponent('el-select') as unknown as string
      const ElOption = resolveComponent('el-option') as unknown as string
      const ElPopconfirm = resolveComponent('el-popconfirm') as unknown as string

      const denied = () => loginGate({
      brand: 'TS',
      title: 'Agent 配置',
      desc: '需要管理员权限 —— 第一个注册的用户自动成为管理员。请登录管理员账号：',
      children: [
        h(ElInput, {
          modelValue: loginName.value,
          'onUpdate:modelValue': (v: string) => { loginName.value = v },
          placeholder: '管理员用户名',
        }),
        h(ElInput, {
          modelValue: loginPass.value,
          'onUpdate:modelValue': (v: string) => { loginPass.value = v },
          type: 'password', showPassword: true,
          placeholder: '密码',
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doAdminLogin() },
        }),
        loginErr.value
          ? h(ElText, { type: 'danger', size: 'small' }, { default: () => loginErr.value })
          : null,
        h(ElButton, {
          type: 'primary', loading: loginBusy.value, style: 'width:100%',
          onClick: () => void doAdminLogin(),
        }, { default: () => '登录并进入 Agent 配置' }),
      ],
    })

      const statusTag = (s: string) => h(ElTag, {
        type: s === 'idle' ? 'info' : s === 'working' ? 'success' : s === 'paused' ? 'warning' : 'primary',
        size: 'small',
      }, { default: () => s })

      const panel = () => [
        pageHead('Agent 配置',
          '名册来自入驻注册表；提示词改动下一回合即生效；自治预算每次闸门现读。Coding Agent 由确定性服务流程驱动，提示词仅对会议 Agent 生效。',
          {
            statuses: [
              { text: `LLM ${cfg.value?.llmConfigured ? '已配置（真模型）' : '未配置（占位留痕）'}`, level: cfg.value?.llmConfigured ? 'ok' : 'warn' },
              { text: `入驻 Agent ${cfg.value?.roster.length ?? 0} 个`, level: 'ok' },
            ],
            actions: [
              { label: '登出', onClick: () => { localStorage.removeItem(TOKEN_KEY); location.href = '/' }, danger: true },
            ],
          }),
        msg.value ? note(msg.value, msgOk.value) : null,

        // ── 自治预算 ────────────────────────────────────────────────
        section('自治预算',
          '每个回合内 Agent 自主动作（委托 / 续步）的上限；超限暂停等人（budget_exhausted），由人类下一条发言开启新回合。',
          [
            actionsRow([
              h(ElInputNumber, {
                modelValue: budget.value,
                'onUpdate:modelValue': (v: number | undefined) => { budget.value = v ?? 0 },
                min: 0, max: 50, style: 'width:150px',
              }),
              h(ElButton, { type: 'primary', loading: busy.value, onClick: () => void doSaveBudget() },
                { default: () => '保存' }),
              h(ElText, { size: 'small', type: 'info' },
                { default: () => '0 = 用缺省（8）' }),
            ]),
          ]),

        // ── 名册 ────────────────────────────────────────────────────
        section('Agent 名册',
          '会议 Agent 可改提示词（重定向到任意已保存模板）；Coding Agent 的行为由 /code /test /review 流程定义。新建的 Agent 会自动加入全部进行中会议。',
          [
            h(ElTable, { data: cfg.value?.roster ?? [], size: 'small' }, {
              default: () => [
                h(ElTableColumn, { prop: 'title', label: '标题', width: 120 }),
                h(ElTableColumn, { prop: 'id', label: 'id', width: 130 }),
                h(ElTableColumn, { label: '类别', width: 96 }, {
                  default: (sc: { row: RosterRow }) => h(ElTag, {
                    type: sc.row.id.startsWith('a_custom_') ? 'success' : sc.row.kind === 'meeting' ? 'primary' : 'warning',
                    size: 'small', effect: 'plain',
                  }, { default: () => (sc.row.id.startsWith('a_custom_') ? '自定义' : sc.row.kind === 'meeting' ? '会议' : 'Coding') }),
                }),
                h(ElTableColumn, { label: '职责', width: 140 }, {
                  default: (sc: { row: RosterRow }) => sc.row.roleLabel || '—',
                }),
                h(ElTableColumn, { prop: 'status', label: '状态', width: 90 }, {
                  default: (sc: { row: RosterRow }) => status({
                    text: sc.row.status,
                    level: sc.row.status === 'working' ? 'ok' : sc.row.status === 'paused' ? 'warn' : sc.row.status === 'done' ? 'idle' : 'idle',
                    title: '生命周期状态（idle 待命 / working 干活 / paused 暂停 / done 交付）',
                  }),
                }),
                h(ElTableColumn, { label: '提示词', minWidth: 200 }, {
                  default: (sc: { row: RosterRow }) => h('span', null,
                    sc.row.promptOverride
                      ? `${sc.row.promptOverride}（已重定向）`
                      : (sc.row.promptRef || '（无 —— stub 行为）')),
                }),
                h(ElTableColumn, { label: '操作', width: 160 }, {
                  default: (sc: { row: RosterRow }) => h(ElSpace, { size: 4 }, {
                    default: () => [
                      h(ElButton, {
                        size: 'small', link: true, type: 'primary',
                        disabled: sc.row.kind !== 'meeting',
                        onClick: () => { paAgent.value = sc.row; paRef.value = sc.row.promptOverride; paVisible.value = true },
                      }, { default: () => '改提示词' }),
                      sc.row.id.startsWith('a_custom_')
                        ? h(ElPopconfirm, {
                            title: `删除「${sc.row.title}」？将同时退出全部会议`,
                            onConfirm: () => void doRemoveAgent(sc.row),
                          }, {
                            reference: () => h(ElButton, { size: 'small', link: true, type: 'danger' },
                              { default: () => '删除' }),
                          })
                        : null,
                    ],
                  }),
                }),
              ],
            }),
          ], h(ElButton, {
            size: 'small', type: 'primary',
            onClick: () => { naVisible.value = true },
          }, { default: () => '+ 新建 Agent' })),

        // ── 提示词模板 ──────────────────────────────────────────────
        section('提示词模板',
          'ref 幂等 upsert：选中一条编辑正文保存即可；会议 Agent 下一回合组装（L4）即用新文案。',
          [
            h('div', { class: 'sp-grid' }, [
              field('选择模板', h(ElSelect, {
                modelValue: selRef.value,
                'onUpdate:modelValue': (v: string) => pick(v),
                placeholder: '选择模板',
                style: 'width:100%',
              }, {
                default: () => (cfg.value?.prompts ?? []).map((p) =>
                  h(ElOption, { key: p.ref, value: p.ref, label: `${p.title}（${p.ref}）` })),
              }), undefined, true),
              field('模板标题', h(ElInput, {
                modelValue: edTitle.value,
                'onUpdate:modelValue': (v: string) => { edTitle.value = v },
                placeholder: '模板标题',
              }), undefined, true),
              field('模板正文（system 提示词）', h(ElInput, {
                modelValue: edBody.value,
                'onUpdate:modelValue': (v: string) => { edBody.value = v },
                type: 'textarea', rows: 8,
                placeholder: '模板正文',
              }), undefined, true),
            ]),
            actionsRow([
              h(ElButton, {
                type: 'primary', loading: busy.value, disabled: !selRef.value,
                onClick: () => void doSavePrompt(),
              }, { default: () => '保存模板' }),
            ]),
          ]),
      ]

      return h('div', { class: 'k-content sp-admin-wrap' }, [
        h(ThemeStyle),
        // 新建 Agent 弹窗（①）。
        h(ElDialog, {
          modelValue: naVisible.value,
          'onUpdate:modelValue': (v: boolean) => { naVisible.value = v },
          title: '新建会议 Agent',
          width: 480,
        }, {
          default: () => [
            h('div', { class: 'sp-field-label' }, '标题（即 @ 目标，请用独特命名）'),
            h(ElInput, {
              modelValue: naTitle.value,
              'onUpdate:modelValue': (v: string) => { naTitle.value = v },
              placeholder: '如：数据分析师',
            }),
            h('div', { class: 'sp-field-label', style: 'margin-top:12px' }, '职责描述（自由文本，决定它的行为提示）'),
            h(ElInput, {
              modelValue: naDuty.value,
              'onUpdate:modelValue': (v: string) => { naDuty.value = v },
              placeholder: '如：专注支付链路的风险评估与合规检查',
            }),
            h('div', { class: 'sp-field-label', style: 'margin-top:12px' }, '提示词模板（可选，可之后在下方改）'),
            h(ElSelect, {
              modelValue: naPromptRef.value,
              'onUpdate:modelValue': (v: string) => { naPromptRef.value = v },
              placeholder: '（可空 = 用角色缺省提示）',
              clearable: true,
              style: 'width:100%',
            }, {
              default: () => (cfg.value?.prompts ?? []).map((p) =>
                h(ElOption, { key: p.ref, value: p.ref, label: `${p.title}（${p.ref}）` })),
            }),
          ],
          footer: () => h('span', null, [
            h(ElButton, { onClick: () => { naVisible.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: naBusy.value, disabled: !naTitle.value, onClick: () => void doCreateAgent() },
              { default: () => '创建并加入会议' }),
          ]),
        }),
        me.value === null
          ? h(ElEmpty, { description: '正在检查权限…' })
          : (me.value ? panel() : denied()),
        // per-agent 提示词重定向弹窗。
        h(ElDialog, {
          modelValue: paVisible.value,
          'onUpdate:modelValue': (v: boolean) => { paVisible.value = v },
          title: `改提示词 —— ${paAgent.value?.title ?? ''}（${paAgent.value?.id ?? ''}）`,
          width: 480,
        }, {
          default: () => [
            h(ElText, { size: 'small', type: 'info' }, {
              default: () => '选择该 Agent 使用的提示词模板；选「(回缺省)」清除重定向。Coding Agent 由确定性流程驱动，不在此列。',
            }),
            h('div', { style: 'height:10px' }),
            h(ElSelect, {
              modelValue: paRef.value,
              'onUpdate:modelValue': (v: string) => { paRef.value = v },
              placeholder: '选择模板',
              style: 'width:100%',
            }, {
              default: () => [
                h(ElOption, { value: '', label: '（回缺省 —— 用描述符里的 promptRef）' }),
                ...(cfg.value?.prompts ?? []).map((p) =>
                  h(ElOption, { key: p.ref, value: p.ref, label: `${p.title}（${p.ref}）` })),
              ],
            }),
          ],
          footer: () => h('span', null, [
            h(ElButton, { onClick: () => { paVisible.value = false } }, { default: () => '取消' }),
            h(ElButton, { type: 'primary', loading: busy.value, onClick: () => void doSaveAgentPrompt() },
              { default: () => '确定' }),
          ]),
        }),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 admin / models 包）────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; icon?: string; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/agents',
    name: 'Agent 配置',
    order: 902,
    icon: 'clipboard-list', component: AgentsPage,
  })
}
