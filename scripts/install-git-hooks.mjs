import { execFileSync } from 'node:child_process'
import { existsSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hook = resolve(root, '.githooks/pre-push')
if (!existsSync(hook)) throw new Error('Missing .githooks/pre-push')
chmodSync(hook, 0o755)
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' })
console.log('已启用本仓库 pre-push 门禁：push 时要求工作树干净，并运行 lint:changes + gate:related。')
