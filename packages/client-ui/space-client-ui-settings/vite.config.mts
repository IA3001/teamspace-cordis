import { defineConfig } from 'vite'

// 与 space-client-ui-admin 同款三件套构建脚（A2 口径）：manifest 出 dist/，
// dist/ 不入库；vue 与 @cordisjs/client 外部化（外壳运行时提供）。
// el-* / k-* 组件是外壳全局注册的：源码只写标签，不 import element-plus。
//
// ⚠ preserveEntrySignatures: 'strict' —— 外壳靠 entry chunk 的 default
// export（页面插件）驱动装载；Vite 对自定义 input 默认把入口导出摇掉。
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
