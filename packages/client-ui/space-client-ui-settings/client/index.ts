// 模型与接入页（客户端）—— 2026-10-05 新增；同日「专业界面」改版。
//
// 结构（console.ts 版式词汇）：
//   pageHead（标题 + 状态胶囊：LLM/Embedding 可用性 + 页级导航）
//   ├ note（保存/测试结果内联条，替代 el-alert）
//   ├ section 语言模型（LLM）：双列栅格表单 + 操作行（保存/连通测试）
//   └ section 向量模型（Embedding）：同上
//
// apiKey 口径：只写不回显（getConfig 返回 hasKey/keyTail）；留空保留现值，
// 输入「-」清除。保存即生效（ctx.settings 现读），无需重启。
//
// 铁律 1：只用外壳全局注册的 el-*（resolveComponent），样式走 im.css 共享段。
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRpc, useRoute } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { pageHead, section, field, actionsRow, note, loginGate } from 'space-client-ui-shared/client/console.ts'

/** getConfig 的返回形状。 */
interface ConfigShape {
  llm: { baseURL: string; model: string; hasKey: boolean; keyTail: string; timeoutMs: number }
  embed: { baseURL: string; model: string; hasKey: boolean; keyTail: string }
  env: { llmConfigured: boolean; embedConfigured: boolean }
}

/** 测试/写操作的返回：{ ok, detail? } 或 { ok:false, error, detail }。 */
interface OpResult { ok?: boolean; detail?: string; error?: string }

const TOKEN_KEY = 'space_token'
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''

const SettingsPage = defineComponent({
  name: 'SpaceSettingsPage',
  setup() {
    const route = useRoute()

    // 拒绝态就地登录（状态必须在 setup 体 —— 渲染闭包里会每次重建）。
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
      me(token: string): Promise<{ id: string; isAdmin: boolean } | null>
      getConfig(token: string): Promise<ConfigShape | null>
      saveLlm(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string; timeoutMs?: number }): Promise<OpResult | null>
      saveEmbed(token: string, cfg: { baseURL?: string; model?: string; apiKey?: string }): Promise<OpResult | null>
      testLlm(token: string): Promise<OpResult | null>
      testEmbed(token: string): Promise<OpResult | null>
      login(username: string, password: string): Promise<{ token: string } | { error: string; detail?: string }>
    }>()

    const me = ref<{ id: string; isAdmin: boolean } | null | undefined>(null)
    const cfg = ref<ConfigShape | null>(null)
    const msg = ref('')
    const msgOk = ref(true)
    const busy = ref(false)

    // 表单草稿（apiKey 独立 —— 只写不回显）。
    const llmBase = ref('')
    const llmModel = ref('')
    const llmKey = ref('')
    const llmTimeout = ref(60000)
    const embedBase = ref('')
    const embedModel = ref('')
    const embedKey = ref('')
    // 各自的连通测试结果（内联在操作行）。
    const llmResult = ref<{ ok: boolean; text: string } | null>(null)
    const embedResult = ref<{ ok: boolean; text: string } | null>(null)

    async function refresh() {
      const c = await rpc.value.getConfig(getToken())
      if (!c) return
      cfg.value = c
      if (!llmBase.value && !llmModel.value) {
        llmBase.value = c.llm.baseURL
        llmModel.value = c.llm.model
        llmTimeout.value = c.llm.timeoutMs
        embedBase.value = c.embed.baseURL
        embedModel.value = c.embed.model
      }
    }

    onMounted(async () => {
      const qtoken = route.query.token
      if (typeof qtoken === 'string' && qtoken) localStorage.setItem(TOKEN_KEY, qtoken)
      const m = await rpc.value.me(getToken())
      if (!m || !m.isAdmin) { me.value = undefined; return }
      me.value = m
      await refresh()
    })

    async function doSaveLlm() {
      busy.value = true
      try {
        const r = await rpc.value.saveLlm(getToken(), {
          baseURL: llmBase.value, model: llmModel.value,
          apiKey: llmKey.value ? llmKey.value : undefined,
          timeoutMs: Number(llmTimeout.value) || 60000,
        })
        if (r?.ok) { llmKey.value = ''; await refresh(); msgOk.value = true; msg.value = 'LLM 设置已保存，立即生效。' }
        else { msgOk.value = false; msg.value = r?.detail ?? r?.error ?? '保存失败' }
      } finally { busy.value = false }
    }

    async function doTestLlm() {
      busy.value = true
      llmResult.value = null
      try {
        const r = await rpc.value.testLlm(getToken())
        llmResult.value = { ok: Boolean(r?.ok), text: r?.detail ?? r?.error ?? '测试失败' }
      } finally { busy.value = false }
    }

    async function doSaveEmbed() {
      busy.value = true
      try {
        const r = await rpc.value.saveEmbed(getToken(), {
          baseURL: embedBase.value, model: embedModel.value,
          apiKey: embedKey.value ? embedKey.value : undefined,
        })
        if (r?.ok) { embedKey.value = ''; await refresh(); msgOk.value = true; msg.value = 'Embedding 设置已保存，立即生效。' }
        else { msgOk.value = false; msg.value = r?.detail ?? r?.error ?? '保存失败' }
      } finally { busy.value = false }
    }

    async function doTestEmbed() {
      busy.value = true
      embedResult.value = null
      try {
        const r = await rpc.value.testEmbed(getToken())
        embedResult.value = { ok: Boolean(r?.ok), text: r?.detail ?? r?.error ?? '测试失败' }
      } finally { busy.value = false }
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElInputNumber = resolveComponent('el-input-number') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string

      const denied = () => loginGate({
      brand: 'TS',
      title: '模型与接入',
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
        }, { default: () => '登录' }),
      ],
    })

      /** 密钥字段的 placeholder（表达「只写不回显」语义）。 */
      const keyPlaceholder = (c: { hasKey: boolean } | undefined) =>
        c?.hasKey ? '已保存 —— 留空保留现值，输入 - 清除' : 'sk-…'

      const llmSection = () => section('语言模型（LLM）',
        '会议与 Coding 的对话推理都走这一路；OpenAI 兼容口，填直连供应商或 new-api 网关地址均可。',
        [
          h('div', { class: 'sp-grid' }, [
            field('Base URL', h(ElInput, {
              modelValue: llmBase.value,
              'onUpdate:modelValue': (v: string) => { llmBase.value = v },
              placeholder: 'https://…/v1',
            }), undefined, true),
            field('模型名', h(ElInput, {
              modelValue: llmModel.value,
              'onUpdate:modelValue': (v: string) => { llmModel.value = v },
              placeholder: '如 deepseek-chat / qwen3-max',
            })),
            field('超时（ms）', h(ElInputNumber, {
              modelValue: llmTimeout.value,
              'onUpdate:modelValue': (v: number | undefined) => { llmTimeout.value = v ?? 60000 },
              min: 1000, step: 1000, style: 'width:100%',
            })),
            field('API Key', h(ElInput, {
              modelValue: llmKey.value,
              'onUpdate:modelValue': (v: string) => { llmKey.value = v },
              type: 'password', showPassword: true,
              placeholder: keyPlaceholder(cfg.value?.llm),
            }), '只写不回显：留空保留现值；输入「-」清除已存 Key。', true),
          ]),
          actionsRow([
            h(ElButton, { type: 'primary', loading: busy.value, onClick: () => void doSaveLlm() },
              { default: () => '保存' }),
            h(ElButton, { loading: busy.value, onClick: () => void doTestLlm() },
              { default: () => '连通测试' }),
          ], llmResult.value),
        ],
        // 分区头右侧：掩码 key 指纹。
        cfg.value?.llm.hasKey
          ? h('span', { class: 'sp-keyview', title: '已保存的 API Key（尾 4 位）' }, `…${cfg.value.llm.keyTail}`)
          : null)

      const embedSection = () => section('向量模型（Embedding）',
        '记忆与知识库检索的向量化；可与 LLM 使用不同供应商。',
        [
          h('div', { class: 'sp-grid' }, [
            field('Base URL', h(ElInput, {
              modelValue: embedBase.value,
              'onUpdate:modelValue': (v: string) => { embedBase.value = v },
              placeholder: 'https://…/v1',
            }), undefined, true),
            field('向量模型名', h(ElInput, {
              modelValue: embedModel.value,
              'onUpdate:modelValue': (v: string) => { embedModel.value = v },
              placeholder: '如 text-embedding-3-small',
            })),
            field('API Key', h(ElInput, {
              modelValue: embedKey.value,
              'onUpdate:modelValue': (v: string) => { embedKey.value = v },
              type: 'password', showPassword: true,
              placeholder: keyPlaceholder(cfg.value?.embed),
            }), '只写不回显：留空保留现值；输入「-」清除已存 Key。', true),
          ]),
          actionsRow([
            h(ElButton, { type: 'primary', loading: busy.value, onClick: () => void doSaveEmbed() },
              { default: () => '保存' }),
            h(ElButton, { loading: busy.value, onClick: () => void doTestEmbed() },
              { default: () => '连通测试' }),
          ], embedResult.value),
        ],
        cfg.value?.embed.hasKey
          ? h('span', { class: 'sp-keyview', title: '已保存的 API Key（尾 4 位）' }, `…${cfg.value.embed.keyTail}`)
          : null)

      const panel = () => [
        pageHead('模型与接入',
          '统一走 OpenAI 兼容口。推荐先用 new-api 网关（deploy/docker-compose.newapi.yml，管理页 :3000）把各家供应商收敛成一个入口，这里只填网关地址 + 令牌。',
          {
            statuses: [
              { text: `语言模型 ${cfg.value?.env.llmConfigured ? '可用' : '未配置'}`, level: cfg.value?.env.llmConfigured ? 'ok' : 'warn' },
              { text: `向量模型 ${cfg.value?.env.embedConfigured ? '可用' : '未配置'}`, level: cfg.value?.env.embedConfigured ? 'ok' : 'warn' },
            ],
            actions: [
              { label: '登出', onClick: () => { localStorage.removeItem(TOKEN_KEY); location.href = '/' }, danger: true },
            ],
          }),
        msg.value ? note(msg.value, msgOk.value) : null,
        llmSection(),
        embedSection(),
      ]

      return h('div', { class: 'k-content sp-admin-wrap' }, [
        h(ThemeStyle),
        me.value === null
          ? h(ElEmpty, { description: '正在检查权限…' })
          : (me.value ? panel() : denied()),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 admin 包）──────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/models',
    name: '模型与接入',
    order: 901,
    icon: 'tools', component: SettingsPage,
  })
}
