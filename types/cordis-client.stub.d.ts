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
