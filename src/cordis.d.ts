// 把 cordis 生态插件的**类型增强**拉进编译单元。
//
// 为什么需要这个文件：
//   cordis.yml 是运行时清单，插件由 Loader 在运行时按名字加载，**不需要在 TS 里 import**。
//   而 `ctx.server` 这类属性是靠各插件里的 `declare module 'cordis'` 增强出来的
//   （@cordisjs/plugin-server/lib/index.d.ts）。TS 看不见没被 import 的模块，
//   于是 `ctx.server` 报 TS2339「Property 'server' does not exist on type 'Context'」。
//   这是**类型可见性**问题，不是运行问题 —— 运行期一直是对的。
//
// 只做类型引入，运行时不加载任何东西（.d.ts 不会被 emit，也不会被 tsx 执行）。
//
// 以后用到别的服务（如 ctx.model / ctx.webui）时，在下面补一行同样的 import 即可。
import type {} from '@cordisjs/plugin-server'