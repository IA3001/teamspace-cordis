// 5174 /admin 桥接页（客户端）—— 无界面，装载即跳。
//
// token 从 localStorage（space_token，与 /login、teamspace 页共用口径）取；
// 5172 与 5174 同 origin 不同端口，localStorage 按 origin 隔离 —— 5172 的
// admin 页自己支持 ?token= 消费，所以这里把 token 拼进 URL 交过去。
import { defineComponent, h, onMounted, ref } from 'vue'
import { useRpc } from '@cordisjs/client'

const BridgePage = defineComponent({
  name: 'SpaceAdminBridge',
  setup() {
    const rpc = useRpc<{ consolePort(): Promise<number> }>()
    const failed = ref(false)
    const target = ref('')
    onMounted(async () => {
      // 延迟一拍再 replace：SPA 外壳启动中立刻跳转会被当作中断的导航
      //（chrome-error://chromewebdata，实测踩坑）；200ms 足够外壳挂稳。
      const port = await rpc.value.consolePort().catch(() => 5172)
      const token = localStorage.getItem('space_token') ?? ''
      target.value = `http://${location.hostname}:${port}/admin?token=${encodeURIComponent(token)}`
      setTimeout(() => {
        try { location.replace(target.value) } catch { failed.value = true }
        // 800ms 后还在本页 = replace 没生效，展示手动链接兜底。
        setTimeout(() => { failed.value = true }, 800)
      }, 200)
    })
    return () => h('div', { style: 'padding:48px;text-align:center;color:var(--el-text-color-secondary)' }, [
      '正在跳转到账号管理…',
      failed.value
        ? h('p', null, [
            h('a', { href: target.value, style: 'color:var(--el-color-primary)' }, '点这里手动跳转'),
          ])
        : null,
    ])
  },
})

// ── 页面注册（外壳装载约定：default 必须是页面插件函数，不能是裸组件）──
interface PageCtx {
  client: {
    router: {
      page(options: { path: string; name: string; order?: number; component: unknown }): void
    }
  }
}

export default function main(ctx: PageCtx) {
  ctx.client.router.page({
    path: '/admin',
    name: '账号管理',
    order: 980,
    component: BridgePage,
  })
}
