// 应用入口 —— 框架启动代码，**零业务**。
//
// 结构完全对照官方启动器 node_modules/cordis/bin.js（cordis@4.0.0-rc.10）：
//   1. 建根 Context
//   2. baseUrl 指向当前工作目录（loader 据此解析 './plugins/...' 这类相对路径）
//   3. 挂载 Loader 插件
//   4. 让 Loader 载入 include 插件，由 include 读取组合清单组装整个应用
//
// 与官方 bin.js 的差异有两处：
//   · 清单路径来自 config/app.yml（可按环境切换），不写死
//   · 启动时先跑 P5 组合引擎（src/compose.ts）：bundle 层 + 用户层 patch 叠加
//     生成组合清单（路径 = app.yml 的 loader.configPath，产物不入库）。
//     组合失败 / 断言 ③ 不过 = 启动失败（fail fast），不带旧产物裸奔。
//
// 端口等运行参数**不在这里解析** —— 它们是 .env 的职责（scripts/env.sh 用
// node 官方 --env-file 载入），清单里的 !!js 表达式由 loader 端求值（compose
// 阶段不求值、原样透传）。入口只做一件事：把当前生效的口径打出来，便于核对一致性。
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { pathToFileURL } from 'node:url'
import { loadAppConfig } from './config.ts'
import { composeTo } from './compose.ts'

const config = loadAppConfig()

// 入口阶段用 console.log 而不是 ctx.logger：
// 此时 logger 服务上没有任何导出器，走 ctx.logger 会静默丢弃（实测，2026-09-26）。
console.log(`[${config.app.name}] 启动中（NODE_ENV=${process.env.NODE_ENV ?? '-'}）`)
console.log(
  `[${config.app.name}] 监听口径 ${process.env.APP_HOST}:${process.env.APP_PORT}（来自 .env）`,
)

// P5 组合收敛：bundle 层 + 用户层叠加生成最终清单
const composed = composeTo(config.loader.configPath)
console.log(
  `[${config.app.name}] 组合清单 ${composed.total} 行（停用 ${composed.disabled}），` +
    `${composed.layers.length} 个 patch 层 → ${composed.path}`,
)

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: { path: config.loader.configPath },
})

console.log(`[${config.app.name}] 框架启动完成（插件清单：${config.loader.configPath}）`)
