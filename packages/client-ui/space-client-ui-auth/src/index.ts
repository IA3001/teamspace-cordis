// space-client-ui-auth —— 登录/注册页（IM 化改造 2026-09-30 新增包）。
//
// 入驻：独立页面 /login（routes: ['/login']）。
//
// 2026-10-02 修复：登录/注册原本走相对路径 fetch('/api/auth/*')——但本页
// 宿主是 5174，而认证接口在 8080 后端，相对路径请求打到 5174 得到空响应
// （前端报 "Unexpected end of JSON input"）。改为 **webui RPC 直调**
// ctx.users（与全部其它页面同一通道，token 落 localStorage）；HTTP /api/auth/*
// 仍保留（curl/脚本用），并支持 Bearer 头（见 plugins/space-auth readToken）。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type { PublicUser, TokenGrant } from 'space-identity'

export const name = 'space-client-ui-auth'
export const inject = ['webui', 'users']

export function apply(ctx: Context) {
  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts',
      manifest: '../dist/manifest.json',
      routes: ['/login'],
    },
    {
      /** 注册（RPC 直调 users 缝）。返回 {user, token?} 或 {error, detail}。 */
      async register(username: string, password: string, displayName: string) {
        try {
          const user = await ctx.users.register(username, password, displayName)
          // 注册即登录（业界惯例），签发 token 随响应返回。
          const grant: TokenGrant = await ctx.users.login(username, password)
          return { user, token: grant.token }
        } catch (e) {
          const err = e as { code?: string; message?: string; name?: string }
          if (err.name === 'IdentityError') {
            return { error: err.code ?? 'register_failed', detail: err.message ?? '' }
          }
          return { error: 'register_failed', detail: String((e as Error).message ?? e) }
        }
      },
      /** 登录（RPC 直调）。返回 {user, token} 或 {error, detail}。 */
      async login(username: string, password: string) {
        try {
          const grant: TokenGrant = await ctx.users.login(username, password)
          const user: PublicUser = await ctx.users.verifyToken(grant.token)
          return { user, token: grant.token }
        } catch (e) {
          const err = e as { code?: string; message?: string; name?: string }
          if (err.name === 'IdentityError') {
            return { error: err.code ?? 'bad_credentials', detail: err.message ?? '用户名或密码不正确' }
          }
          return { error: 'login_failed', detail: String((e as Error).message ?? e) }
        }
      },
    },
  )
}
