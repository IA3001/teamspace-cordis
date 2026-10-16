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
import type { VNodeChild } from 'vue'
import { useRpc } from '@cordisjs/client'
import { ThemeStyle } from 'space-client-ui-shared/client/theme.ts'
import { userFacingFailure } from 'space-client-ui-shared/client/errors.ts'

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
      me(token: string): Promise<PublicUserView | null>
    }>()

    // me 探测：null = 还在探测；undefined = 未登录（出表单）；对象 = 已登录。
    const me = ref<PublicUserView | null | undefined>(null)
    const expiredToken = ref(false)
    const probeFailed = ref(false)

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

    /** 验证存储的 token，只有服务端确认有效时才显示已登录。 */
    async function probe() {
      const token = localStorage.getItem(TOKEN_KEY)
      expiredToken.value = false
      probeFailed.value = false
      if (!token) {
        me.value = undefined
        return
      }
      me.value = null
      try {
        const user = await rpc.value.me(token)
        if (user) {
          me.value = user
        } else {
          localStorage.removeItem(TOKEN_KEY)
          expiredToken.value = true
          me.value = undefined
        }
      } catch {
        probeFailed.value = true
        me.value = undefined
      }
    }
    onMounted(() => { void probe() })

    /** 登录成功统一出口：存 token + 用户名 → 跳团队空间。 */
    function accept(user: PublicUserView, token: string) {
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem('space_last_username', user.username)
      location.href = '/teamspace'
    }

    async function doLogin() {
      if (loginBusy.value) return
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
      } catch {
        loginFails.value += 1
        loginErr.value = userFacingFailure('登录')
      } finally {
        loginBusy.value = false
      }
    }

    async function doRegister() {
      if (regBusy.value) return
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
      } catch {
        regErr.value = userFacingFailure('注册')
      } finally {
        regBusy.value = false
      }
    }

    return () => {
      const ElButton = resolveComponent('el-button') as unknown as string
      const ElCard = resolveComponent('el-card') as unknown as string
      const ElEmpty = resolveComponent('el-empty') as unknown as string
      const ElAlert = resolveComponent('el-alert') as unknown as string
      const ElForm = resolveComponent('el-form') as unknown as string
      const ElInput = resolveComponent('el-input') as unknown as string
      const ElSpace = resolveComponent('el-space') as unknown as string
      const ElTabs = resolveComponent('el-tabs') as unknown as string
      const ElTabPane = resolveComponent('el-tab-pane') as unknown as string
      const ElFormItem = resolveComponent('el-form-item') as unknown as string
      const ElText = resolveComponent('el-text') as unknown as string
      const formField = (label: string, id: string, control: VNodeChild) =>
        h(ElFormItem, { label, for: id }, { default: () => control })

      // 已登录态复用登录卡的容器和状态标识，保持窄屏尺寸与页面视觉一致。
      const loggedIn = () => {
        return h(ElCard, { class: 'sp-auth-card', shadow: 'hover' }, {
          default: () => h(ElSpace, { direction: 'vertical', fill: true, size: 'large' }, {
            default: () => [
              h('div', { class: 'sp-status sp-status--ok' }, [h('i'), '已登录']),
              h(ElText, { type: 'info' }, {
                default: () => '登录凭证有效。进入团队空间，或在上方切换账号。',
              }),
              h(ElButton, {
                type: 'primary', class: 'sp-login-btn',
                onClick: () => { location.href = '/teamspace' },
              }, { default: () => '进入团队空间' }),
            ],
          }),
        })
      }

      const loginStateNotice = () => {
        if (expiredToken.value) {
          return h(ElAlert, {
            title: '之前的登录凭证已失效，请重新登录。',
            type: 'warning', closable: false,
          })
        }
        if (probeFailed.value) {
          return h(ElSpace, { direction: 'vertical', fill: true }, {
            default: () => [
              h(ElAlert, {
                title: '暂时无法验证登录状态。请重试，或重新登录。',
                type: 'warning', closable: false,
              }),
              h(ElButton, { onClick: () => { void probe() } }, {
                default: () => '重试验证',
              }),
            ],
          })
        }
        return null
      }

      const loginPane = () => h(ElForm, { labelPosition: 'top' }, {
        default: () => [
          formField('用户名', 'login-username', h(ElInput, {
            id: 'login-username',
            modelValue: loginName.value,
            'onUpdate:modelValue': (v: string) => { loginName.value = v },
            placeholder: '用户名',
            autocomplete: 'username',
            autocapitalize: 'none',
            autofocus: !loginName.value,
          })),
          formField('密码', 'login-password', h(ElInput, {
            id: 'login-password',
            modelValue: loginPass.value,
            'onUpdate:modelValue': (v: string) => { loginPass.value = v },
            type: 'password',
            showPassword: true,
            placeholder: '密码',
            autocomplete: 'current-password',
            autofocus: Boolean(loginName.value),
            onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doLogin() },
          })),
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
            disabled: !loginName.value.trim() || !loginPass.value,
            onClick: () => void doLogin(),
          }, { default: () => '登录' }),
        ],
      })

      const registerPane = () => h(ElForm, { labelPosition: 'top' }, {
        default: () => [
          formField('登录名', 'register-username', h(ElInput, {
            id: 'register-username',
            modelValue: regName.value,
            'onUpdate:modelValue': (v: string) => { regName.value = v },
            placeholder: '用户名（登录用，全库唯一）',
            autocomplete: 'username',
            autocapitalize: 'none',
          })),
          formField('密码', 'register-password', h(ElInput, {
            id: 'register-password',
            modelValue: regPass.value,
            'onUpdate:modelValue': (v: string) => { regPass.value = v },
            type: 'password',
            showPassword: true,
            placeholder: '密码',
            autocomplete: 'new-password',
          })),
          formField('显示名（可选）', 'register-display-name', h(ElInput, {
            id: 'register-display-name',
            modelValue: regDisplay.value,
            'onUpdate:modelValue': (v: string) => { regDisplay.value = v },
            placeholder: '显示名（会话里的称呼，可留空）',
            autocomplete: 'nickname',
            onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void doRegister() },
          })),
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
            disabled: !regName.value.trim() || !regPass.value,
            onClick: () => void doRegister(),
          }, { default: () => '注册' }),
        ],
      })

      const card = () => h(ElCard, { class: 'sp-auth-card', shadow: 'hover' }, {
        default: () => [
          loginStateNotice(),
          // 品牌区：名字 + 一句话定位（替代素 header）。
          h('div', { class: 'sp-login-brand' }, [
            h('div', { class: 'sp-login-logo' }, 'TS'),
            h('div', { class: 'sp-login-title' }, '团队空间'),
            h('div', { class: 'sp-login-sub' }, '登录团队账号，进入共享会话与 Agent 协作。'),
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
        me.value === null
          ? h(ElEmpty, { description: '正在检查登录状态…' })
          : me.value ? loggedIn() : card(),
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
    component: AuthPage,
  })
}
