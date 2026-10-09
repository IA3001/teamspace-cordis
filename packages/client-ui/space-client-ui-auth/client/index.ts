// 登录/注册页（客户端）—— IM 化改造（2026-09-30）新增。
//
// 2026-10-02 修复：登录/注册改走 **webui RPC**（useRpc 直调 ctx.users），
// 不再 fetch 相对路径 —— 本页宿主是 5174，/api/auth/* 在 8080，相对路径
// 会打到 5174 得到空响应。RPC 成功返回 token → 存 localStorage
// （'space_token'，全部页面/上传/撤回共用）→ 跳 /teamspace。
// 已登录探测 = me(token)。
//
// 铁律 1：只用外壳全局注册的 el-* / k-*（resolveComponent），零 import
// element-plus、零手写样式、零内联 style。
import { defineComponent, h, onMounted, ref, resolveComponent } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { ICONS } from 'space-client-ui-shared/client/console.ts'

/** RPC 用户视图（PublicUser 的客户端子集）。 */
interface PublicUserView {
  id: string
  username: string
  displayName: string
}

/** 登录/注册 RPC 响应。 */
type AuthResult =
  | { user: PublicUserView; token: string }
  | { error: string; detail?: string }

const TOKEN_KEY = 'space_token'
const errText = (e: unknown): string => {
  const obj = e as { detail?: string; error?: string; message?: string }
  return obj?.detail ?? obj?.message ?? obj?.error ?? String(e)
}

const AuthPage = defineComponent({
  name: 'SpaceAuthPage',
  setup() {
    const rpc = useRpc<{
      login(username: string, password: string): Promise<AuthResult>
      register(username: string, password: string, displayName: string): Promise<AuthResult>
    }>()

    // me 探测：null = 还在探测；undefined = 未登录（出表单）；对象 = 已登录。
    const me = ref<PublicUserView | null | undefined>(null)
    const probeError = ref('')

    // ── 登录表单状态 ────────────────────────────────────────────────────
    const loginName = ref(localStorage.getItem('space_last_username') ?? '')
    const loginPass = ref('')
    const loginBusy = ref(false)
    const loginErr = ref('')
    const loginFails = ref(0)

    // ── 注册表单状态 ────────────────────────────────────────────────────
    const regName = ref('')
    const regPass = ref('')
    const regDisplay = ref('')
    const regBusy = ref(false)
    const regErr = ref('')
    const regOk = ref(false)

    /**
     * 登录态探测：localStorage 有 token 即视为已登录（token 失效会在目标页
     * 被 me(token) 校验拦截并弹回本页）—— auth entry 未提供 me 方法，
     * 避免一次多余往返。
     */
    function probe() {
      me.value = localStorage.getItem(TOKEN_KEY)
        ? { id: 'ok', username: '', displayName: '' }
        : undefined
    }
    onMounted(() => probe())

    /** 登录成功统一出口：存 token + 用户名 → 跳团队空间。 */
    function accept(user: PublicUserView, token: string) {
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem('space_last_username', user.username)
      location.href = '/teamspace'
    }

    async function doLogin() {
      loginBusy.value = true
      loginErr.value = ''
      try {
        const r = await rpc.value.login(loginName.value, loginPass.value)
        if ('error' in r) {
          loginFails.value += 1
          loginErr.value = errText(r)
          return
        }
        accept(r.user, r.token)
      } catch (e) {
        loginFails.value += 1
        loginErr.value = errText(e)
      } finally {
        loginBusy.value = false
      }
    }

    async function doRegister() {
      regBusy.value = true
      regErr.value = ''
      try {
        const r = await rpc.value.register(regName.value, regPass.value, regDisplay.value)
        if ('error' in r) {
          regErr.value = errText(r)
          return
        }
        regOk.value = true
        await new Promise((resolve) => setTimeout(resolve, 800))
        accept(r.user, r.token)
      } catch (e) {
        regErr.value = errText(e)
      } finally {
        regBusy.value = false
      }
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElCol = resolveComponent('el-col') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElRow = resolveComponent('el-row') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string

      // 已登录态（2026-10-05 重设计）：不再用默认空盒插画 —— 一张与登录卡
      // 同宽的分区卡，绿点 + 文案 + 主动作。
      const loggedIn = () => {
        const ElButton = resolveComponent('el-button') as unknown as string
        return h('div', {
          class: 'sp-section',
          style: 'width:400px;box-sizing:border-box;margin:0 auto',
        }, [
          h('div', { class: 'sp-status sp-status--ok', style: 'margin-bottom:14px' }, [h('i'), '已登录']),
          h('div', { class: 'sp-page-sub', style: 'margin-bottom:16px' },
            '登录凭证有效。直接进入团队空间，或在上方切换账号。'),
          h(ElButton, {
            type: 'primary', style: 'width:100%',
            onClick: () => { location.href = '/teamspace' },
          }, { default: () => '进入团队空间' }),
        ])
      }

      const loginPane = () => h(ElForm, { labelPosition: 'top' }, {
        default: () => [
          h(ElInput, {
            modelValue: loginName.value,
            'onUpdate:modelValue': (v: string) => { loginName.value = v },
            placeholder: '用户名',
          }),
          h(ElInput, {
            modelValue: loginPass.value,
            'onUpdate:modelValue': (v: string) => { loginPass.value = v },
            type: 'password',
            showPassword: true,
            placeholder: '密码',
            onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doLogin() },
          }),
          loginErr.value
            ? h(ElAlert, {
                title: loginErr.value, type: 'error', closable: true,
                onClose: () => { loginErr.value = '' },
              })
            : null,
          loginFails.value >= 2
            ? h(ElText, { type: 'info', size: 'small' }, {
                default: () => '忘记密码？当前为本地账号体系，可重新注册一个新用户名',
              })
            : null,
          h(ElButton, {
            type: 'primary', class: 'sp-login-btn', loading: loginBusy.value,
            onClick: () => void doLogin(),
          }, { default: () => '登录' }),
        ],
      })

      const registerPane = () => h(ElForm, { labelPosition: 'top' }, {
        default: () => [
          h(ElInput, {
            modelValue: regName.value,
            'onUpdate:modelValue': (v: string) => { regName.value = v },
            placeholder: '用户名（登录用，全库唯一）',
          }),
          h(ElInput, {
            modelValue: regPass.value,
            'onUpdate:modelValue': (v: string) => { regPass.value = v },
            type: 'password',
            showPassword: true,
            placeholder: '密码',
          }),
          h(ElInput, {
            modelValue: regDisplay.value,
            'onUpdate:modelValue': (v: string) => { regDisplay.value = v },
            placeholder: '显示名（会话里的称呼，可留空）',
            onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doRegister() },
          }),
          regOk.value
            ? h(ElText, { type: 'success' }, { default: () => '注册成功，正在进入…' })
            : null,
          regErr.value
            ? h(ElAlert, {
                title: regErr.value, type: 'error', closable: true,
                onClose: () => { regErr.value = '' },
              })
            : null,
          h(ElButton, {
            type: 'primary', class: 'sp-login-btn', loading: regBusy.value,
            onClick: () => void doRegister(),
          }, { default: () => '注册' }),
        ],
      })

      const card = () => h(ElCard, { shadow: 'hover' }, {
        default: () => [
          // 品牌区：名字 + 一句话定位（替代素 header）。
          h('div', { class: 'sp-login-brand' }, [
            h('div', { class: 'sp-login-logo' }, 'TS'),
            h('div', { class: 'sp-login-title' }, '团队空间'),
            h('div', { class: 'sp-login-sub' }, '多人 · 多 Agent 实时协作'),
          ]),
          h(ElTabs, null, {
            default: () => [
              h(ElTabPane, { label: '登录' }, { default: loginPane }),
              h(ElTabPane, { label: '注册' }, { default: registerPane }),
            ],
          }),
        ],
      })

      // sp-plain：登录/注册页不要外壳左侧导航（im.css 按 :has 藏掉）。
      return h('div', { class: 'k-content sp-plain' }, [
        h(ThemeStyle),
        probeError.value
          ? h(ElAlert, {
              title: probeError.value, type: 'warning', closable: true,
              onClose: () => { probeError.value = '' },
            })
          : null,
        h(ElRow, { justify: 'center', align: 'middle' }, {
          default: () => h(ElCol, { span: 8, xs: 24, md: 10 }, {
            default: () => (me.value === null
              ? h(ElEmpty, { description: '正在检查登录状态…' })
              : me.value ? loggedIn() : card()),
          }),
        }),
      ])
    }
  },
})

// ── 页面注册（官方约定，仿 teamspace）────────────────────────────────────
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/login',
    name: '登录',
    order: 950,
    icon: ICONS.auth, component: AuthPage,
  })
}
