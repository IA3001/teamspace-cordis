// space-cors —— 跨域头中间件（2026-10-02）。
//
// 为什么需要：页面宿主（5174）与后端 HTTP（8080）不同端口，浏览器的
// 撤回 / 上传 fetch 带 Authorization 头属于跨域请求 —— 无 CORS 头会被
// 浏览器直接拦截（ERR_FAILED / 预检失败）。此中间件在 server/request
// 瀑布里给**所有**响应注入跨域头（含自动 OPTIONS 预检的 204 响应）。
//
// 安全口径：局域网协作系统，Allow-Origin 用 * 即可（凭据走 Bearer 头、
// 不依赖 cookie 跨域携带，* 与带凭据的请求本就不兼容，无 CSRF 面扩大）。
import type { Context } from 'cordis'

export const name = 'space-cors'
export const inject = ['server']

export function apply(ctx: Context) {
  ctx.on('server/request', async (_req, res, next) => {
    res.headers.set('Access-Control-Allow-Origin', '*')
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    await next()
  })
  console.log(`[${name}] 就绪：全部响应注入跨域头（撤回/上传跨端口可达）`)
}
