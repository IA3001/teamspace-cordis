// space-client-ui-admin —— 账号管理页（2026-10-01 新增包）。
//
// 入驻：挂在 **5172 调试控制台**（与插件/日志/数据库页同一外壳）。routes
// ['/admin']；不走 HTTP —— 全部数据方法走 webui RPC（像 sessions 包）。
//
// ⚠ isolate 拍板（先 Read 确认过）：debug-webui（@cordisjs/plugin-webui，
// server: debug，端口 5172）的 isolate 只写了 { server: debug } —— 它提供的
// webui 是**无名默认实例**；teampspace 那套才显式命名 webui: teamspace。
// debug-loader-webui / debug-logger-webui / debug-database-webui 都是**不写
// isolate** 直接消费这个无名 webui 才出现在 5172 控制台。所以本包注册行
// 同样**不写 isolate**（写 webui: debug 反而找不到同名 webui 服务）。
//
// 权限口径：所有 data 方法首参 token（localStorage 'space_token'），
// verifyToken 成功且 isAdmin 才放行；非管理员统一返回 null（前端据此出
// 「需要管理员权限」空态）。写操作 IdentityError 被 catch 成 { error, detail }
// 结构化返回，前端展示在页首 alert。
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-webui'
import type { PublicUser } from 'space-identity'
import { IdentityError } from 'space-identity'

export const name = 'space-client-ui-admin'
// users 是 ctx.users（space-store-sqlite 提供）—— RPC 数据函数里摸到的
// 每个服务都要进 inject（P4 教训）。
export const inject = ['webui', 'users', 'settings']

/** token → PublicUser；无效返回 null（不抛，RPC 层零异常面）。 */
async function auth(ctx: Context, token: string): Promise<PublicUser | null> {
  try {
    return await ctx.users.verifyToken(String(token ?? ''))
  } catch {
    return null
  }
}

/** IdentityError → { error, detail } 结构化失败（前端 alert 直接展示）。 */
function fail(e: unknown): { error: string; detail: string } {
  if (e instanceof IdentityError) return { error: e.code, detail: e.message }
  return { error: 'internal', detail: e instanceof Error ? e.message : String(e) }
}

export function apply(ctx: Context) {
  ctx.webui.addEntry(
    {
      baseUrl: import.meta.url,
      source: '../client/index.ts', // 开发态用 —— 我们不启用（A2 构建口径）
      manifest: '../dist/manifest.json', // 生产态用 —— 只走这条
      routes: ['/admin'],
    },
    {
      /** 当前登录用户（verifyToken）；页面据此判断 isAdmin。 */
      async me(token: string) {
        return auth(ctx, token)
      },

      /** 全部用户（human + agent）。仅管理员。 */
      /** 登录（/admin 内置登录表单用 —— 5172 无登录页，拒绝态就地登录）。 */
      async login(username: string, password: string) {
        try {
          const grant = await ctx.users.login(username, password)
          const user = await ctx.users.verifyToken(grant.token)
          return { user, token: grant.token }
        } catch (e) {
          const err = e as { code?: string; message?: string; name?: string }
          return { error: err.code ?? 'login_failed', detail: err.message ?? '登录失败' }
        }
      },
      /** 团队空间页端口（5174，拒绝态引导跳登录用）。 */
      async uiPort(token: string) {
        const u = await auth(ctx, token).catch(() => null)
        return u ? Number(process.env.TEAMSPACE_PORT ?? 5174) : null
      },
      async users(token: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        return ctx.users.listAll()
      },

      /** 重置密码。仅管理员；IdentityError → { error, detail }。 */
      async resetPassword(token: string, userId: string, password: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        try {
          await ctx.users.resetPassword(String(userId), String(password))
          return { ok: true }
        } catch (e) {
          return fail(e)
        }
      },

      /** 设/撤管理员（禁止自降逻辑在服务端已做）。仅管理员。 */
      async setAdmin(token: string, userId: string, v: boolean) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        try {
          await ctx.users.setAdmin(String(userId), Boolean(v))
          return { ok: true }
        } catch (e) {
          return fail(e)
        }
      },

      /** 读注册开关（settings auth.registerEnabled；缺省 true）。 */
      async getRegisterEnabled(token: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        return { enabled: ctx.settings.get<boolean>('auth.registerEnabled', true) }
      },

      /** 设注册开关（仅管理员）。 */
      async setRegisterEnabled(token: string, v: boolean) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        ctx.settings.set('auth.registerEnabled', Boolean(v))
        return { ok: true }
      },

      /** 删除账号。仅管理员。 */
      async removeUser(token: string, userId: string) {
        const me = await auth(ctx, token)
        if (!me?.isAdmin) return null
        try {
          await ctx.users.removeUser(String(userId))
          return { ok: true }
        } catch (e) {
          return fail(e)
        }
      },
    },
  )
}
