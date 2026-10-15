// @cordisjs/client 的**最小类型桩**（P4）。
//
// 为什么不用包自带类型：该包 exports '.' 直指 TS 源码（client/index.ts），
// tsc 顺着类型链会把外壳的整个浏览器端源码拖进本仓库的 typecheck（它的源码
// 依赖 DOM lib / *.vue / style.scss —— 一进来就是几十个无关报错）。
// 这里的桩只声明我们**实际用到**的 API；vite 构建已把该包外部化，运行时走
// 外壳里的真实实现。用到了新 API 就在这里补声明 —— 这份桩同时也是「页面
// 依赖外壳到什么程度」的台账。
import type { Ref } from 'vue'

/** 页面 entry 的 data（服务端 addEntry 第二参）：函数即 RPC，值即共享状态。 */
export declare function useRpc<T = unknown>(): Ref<T>

// ── 外壳路由 / 上下文（2026-09-29 改版新增：URL 同步会话选择 + 跨 entry 槽位视图）──
// 依据 @cordisjs/client@0.8.2 实测源码：
//   · client/plugins/router.ts —— RouterService.slot() 把组件注册进 views[type]，
//     任意 <k-slot name={type}> 都会渲染它（外壳原生跨 entry 组合通道）；
//   · client/plugins/router.ts —— replace()/currentRoute.query 支持编程导航；
//   · client/context.ts —— useContext() 返回当前 entry 的 fiber ctx。

/** 外壳路由位置的最小视图（本仓库只消费 path / query）。 */
export interface ClientRoute {
  path: string
  query: Record<string, string>
}

/** 外壳路由器的最小视图（页面注册 / 槽位视图注册 / 编程导航 / 视图注册表）。 */
export interface ClientRouter {
  page(options: { path: string; name: string; icon?: string; order?: number; component: unknown }): unknown
  slot(options: { type: string; component: unknown; order?: number }): unknown
  push(target: { path?: string; query?: Record<string, string | undefined> }): Promise<void>
  replace(target: { path?: string; query?: Record<string, string | undefined> }): Promise<void>
  /** 已注册的槽位视图（reactive；读 length 可判断某槽位是否有视图入驻）。 */
  readonly views: Record<string, readonly unknown[]>
}

/** 当前组件所属 entry 的上下文（wrapComponent 注入的 kContext）。 */
export declare function useContext(): { client: { router: ClientRouter } }
export declare function useRouter(): ClientRouter
export declare function useRoute(): ClientRoute
