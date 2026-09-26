// 健康检查插件 —— 同时是「服务依赖（inject）」的样板。
//
// inject: ['server'] 的语义（官方，核实日期 2026-09-26）：
//   · server 服务未就绪 → 本插件不加载
//   · server 被重载    → 本插件自动回滚并跟随重载
//   · 加载顺序由依赖决定，与 cordis.yml 里的书写位置无关
//   来源：https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer
//
// 探活口径固定：GET /healthz → 200 + JSON。脚本、前端、以后的反代都认这条。
// 响应里的 listening 是**实际绑定**的地址端口，用来核对它是否等于 .env 的配置值
// —— 端口一致性靠这个当场验，而不是靠"我以为配对了"。
import type { Context } from 'cordis'

export const name = 'health'
export const inject = ['server']

export function apply(ctx: Context) {
  ctx.server.get('/healthz', async () => {
    return Response.json({
      ok: true,
      service: 'teamspace-cordis',
      listening: `${ctx.server.host}:${ctx.server.port}`,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    })
  })
}