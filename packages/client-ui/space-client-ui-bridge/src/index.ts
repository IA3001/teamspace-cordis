// space-client-ui-bridge —— 5174 /admin 桥接页（2026-10-05 新增包）。
//
// 背景：账号管理页实体挂在 5172 调试控制台（webui 无名实例）；用户在 5174
// 直访 /admin 会撞 404。本包在 teamspace webui（5174）注册同名路由，只做
// 一件事：带着 localStorage 的 token 跳到 5172/admin —— 权限校验仍由目标页
// 的 me(token) 负责（未登录 → 就地登录卡片；非管理员 → 拒绝态）。
//
// 端口来源：CONSOLE_PORT env（缺省 5172）；与 .env / run.sh 的控制台端口同源。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'

export const name = 'space-client-ui-bridge'
export const inject = ['webui']

export function apply(ctx: Context) {
  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/admin'],
    },
    {
      /** 调试控制台端口（DEBUG_PORT=5172；CONSOLE_PORT=5173 是未启用的 dev 口）。 */
      async consolePort() {
        return Number(process.env.DEBUG_PORT ?? 5172)
      },
    },
  )
}
