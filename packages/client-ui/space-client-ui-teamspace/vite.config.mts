import { defineConfig } from 'vite'

// 三件套的构建脚（A2 口径）：manifest 出 dist/，dist/ 不入库；
// vue 与 @cordisjs/client 是外壳运行时提供的 —— 外部化（与官方包的 dist 一致）。
// k-* / el-* 组件是外壳全局注册的：源码里只写标签，不 import element-plus。
//
// ⚠ preserveEntrySignatures: 'strict' —— webui 外壳靠 entry chunk 的
// default export（页面插件）注册路由；Vite 对自定义（非 HTML）input 默认
// 把入口导出摇掉，产物变成空壳（2026-09-28 实测：无此行 → 页面全白）。
export default defineConfig({
  build: {
    manifest: true,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'client/index.ts',
      external: [/^vue($|\/)/, /^@cordisjs\/client($|\/)/],
      preserveEntrySignatures: 'strict',
    },
  },
})
