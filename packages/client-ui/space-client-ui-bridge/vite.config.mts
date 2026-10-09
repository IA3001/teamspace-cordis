import { defineConfig } from 'vite'

// 与 admin/models 同款三件套构建脚（A2 口径）。
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
