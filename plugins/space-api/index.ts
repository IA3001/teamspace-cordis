// space-api —— 只读查询路由（P4，用户拍板补齐）。
//
// 时间线 / 成员页的数据源；也是 curl 可查的观测面（铁律 2：数据要看得见）。
// 纯查询、零业务语义：写路径仍然只在 POST /api/sessions/:id/messages
// （staging-commands），这里一个写口都不加。
//   GET /api/sessions                会话清单
//   GET /api/sessions/:id/events     事件（append-only，按 seq 升序）
//   GET /api/sessions/:id/members    在册成员
//   GET /api/users                   人类用户清单（去敏，IM 化邀请成员用）
//   GET /api/panels                  已登记的页内区域（seam/space-ui 注册表）
import type { Context } from 'cordis'

export const name = 'space-api'
export const inject = ['server', 'session', 'eventLog', 'ui', 'users']

export function apply(ctx: Context) {
  ctx.server.get('/api/sessions', async () => Response.json(ctx.session.listSessions()))

  // 人类用户清单（去敏视图，无 passwordHash）——邀请成员 / 观测用。
  ctx.server.get('/api/users', async () => Response.json(await ctx.users.listHumans()))

  ctx.server.get('/api/sessions/:id/events', async (req) => {
    const session = ctx.session.getSession(req.params.id)
    if (!session) {
      return Response.json({ error: 'session_not_found', detail: `会话 ${req.params.id} 不存在` }, { status: 404 })
    }
    return Response.json(ctx.eventLog.listBySession(req.params.id))
  })

  ctx.server.get('/api/sessions/:id/members', async (req) => {
    const session = ctx.session.getSession(req.params.id)
    if (!session) {
      return Response.json({ error: 'session_not_found', detail: `会话 ${req.params.id} 不存在` }, { status: 404 })
    }
    return Response.json(ctx.session.listMembers(req.params.id, true))
  })

  ctx.server.get('/api/panels', async () => Response.json(ctx.ui.listPanels()))
}
