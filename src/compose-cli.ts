// compose-cli.ts —— 组合引擎的命令行入口（lint 校验 / 生成产物）。零业务。
//
// 用法：
//   tsx src/compose-cli.ts --lint          断言 ③ 校验（lint-patch.sh 调它）
//   tsx src/compose-cli.ts [--out <path>]  生成组合产物（默认 composed.cordis.yml，项目根，gitignore）
import { resolve } from 'node:path'
import { composeTo, lintLayers } from './compose.ts'

const args = process.argv.slice(2)

if (args.includes('--lint')) {
  const errors = lintLayers()
  if (errors.length > 0) {
    console.error('✗ patch 层数断言 ③ 未通过：')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  console.log('✓ patch 层数断言 ③ 通过（每行最多「一个 bundle 层 + 用户层」）')
} else {
  const outIdx = args.indexOf('--out')
  const out = outIdx >= 0 ? args[outIdx + 1] : 'composed.cordis.yml'
  const r = composeTo(resolve(process.cwd(), out))
  console.log(`✓ 组合完成：${r.total} 行（停用 ${r.disabled}）→ ${r.path}`)
  for (const l of r.layers) {
    console.log(`  · ${String(l.count).padStart(2)} 行  ${l.file}`)
  }
}
