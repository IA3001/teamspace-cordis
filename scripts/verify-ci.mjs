import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync as awaitReadDirs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectLayers } from './lint-layers.mjs'
import { complexities, checkDocument } from './lint-changes.mjs'

const root = mkdtempSync(join(tmpdir(), 'teamspace-ci-lint-'))
try {
  for (const layer of ['seam', 'impl', 'policy', 'client-ui', 'bundle']) mkdirSync(join(root, 'packages', layer), { recursive: true })
  mkdirSync(join(root, 'plugins'))
  for (const [layer, name] of [['seam', 'space-contract'], ['impl', 'space-a'], ['impl', 'space-b'], ['client-ui', 'space-page']]) {
    const dir = join(root, 'packages', layer, name)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
  }
  const a = join(root, 'packages/impl/space-a/src/index.ts')
  const client = join(root, 'packages/client-ui/space-page/client/index.ts')
  mkdirSync(join(root, 'packages/client-ui/space-page/client'))
  writeFileSync(a, 'import { Service } from "space-contract"')
  writeFileSync(client, 'import type { Shape } from "space-contract"')
  assert.equal(inspectLayers(root).errors.length, 0)
  writeFileSync(a, 'import { Other } from "space-b"')
  assert.equal(inspectLayers(root).errors.length, 1, 'bare imports must fail, including double quotes')
  writeFileSync(client, 'const module = await import("space-a/src/index.ts")')
  assert.equal(inspectLayers(root).errors.length, 2, 'dynamic client implementation import must fail')
  writeFileSync(a, 'export { Other } from "../../space-b/src/index.ts"')
  assert.equal(inspectLayers(root).errors.length, 2, 'relative re-export cannot bypass layers')
  assert(inspectLayers(root).files > 0 && inspectLayers(root).imports > 0, 'scanner must not silently scan zero files')
  assert.equal([...complexities('function f(x: boolean) { if (x) return 1; return 0 }').values()][0], 2)
  assert.equal([...complexities('function f(x) { return x ? (x && 1) : 0 }').values()][0], 3)
  assert.equal(checkDocument('x'.repeat(20481), 20480).length, 1)
  assert(checkDocument(`${'long paragraph '.repeat(12)}\n\n${'long paragraph '.repeat(12)}`, 20480).includes('duplicate long paragraph'))
  const manifest = JSON.parse(readFileSync('package.json'))
  const checks = JSON.parse(readFileSync('.ci/checks.json'))
  for (const names of Object.values(checks)) for (const entry of names) { const name = typeof entry === 'string' ? entry : entry.script; assert(manifest.scripts[name], `missing check ${name}`) }
  assert(checks.static.some((n) => (n.script ?? n) === 'lint:layers'))
  assert(checks.runtime.some((n) => (n.script ?? n) === 'verify:ui') && checks.runtime.some((n) => (n.script ?? n) === 'verify:admin-ui'))
  const diffRoot = join(root, 'diff')
  mkdirSync(join(diffRoot, '.ci'), { recursive: true })
  function git(...args) {
    const result = spawnSync('git', args, { cwd: diffRoot, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'user.name', 'CI fixture'); git('config', 'user.email', 'ci@example.invalid')
  writeFileSync(join(diffRoot, '.ci/change-policy.json'), JSON.stringify({ maxFiles: 5, maxChangedLines: 10, maxDocumentBytes: 100, maxComplexity: 1 }))
  git('add', '.'); git('commit', '-qm', 'baseline')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(diffRoot, 'sample.ts'), 'function sample(x: boolean) { if (x) return 1; return 0 }')
  writeFileSync(join(diffRoot, 'large.md'), 'x'.repeat(101))
  writeFileSync(join(diffRoot, '.ci/change-policy.json'), JSON.stringify({ maxFiles: 999, maxChangedLines: 9999, maxDocumentBytes: 9999, maxComplexity: 999 }))
  git('add', '.'); git('commit', '-qm', 'violations with weakened head policy')
  const budget = spawnSync(process.execPath, [new URL('./lint-changes.mjs', import.meta.url).pathname, base], {
    cwd: diffRoot, encoding: 'utf8', env: { ...process.env, CI_ALLOWED_PATHS: '.ci/' },
  })
  assert.equal(budget.status, 1)
  assert.match(budget.stderr, /complexity 2 exceeds 1/, 'trusted base policy must defeat weakening in HEAD')
  assert.match(budget.stderr, /document exceeds 100 bytes/)
  assert.match(budget.stderr, /outside approved scope/)
  const runnerRoot = join(root, 'runner')
  mkdirSync(join(runnerRoot, 'scripts'), { recursive: true })
  mkdirSync(join(runnerRoot, '.ci'))
  mkdirSync(join(runnerRoot, 'node_modules'))
  mkdirSync(join(runnerRoot, 'data'))
  writeFileSync(join(runnerRoot, 'scripts/ci.mjs'), readFileSync('scripts/ci.mjs'))
  mkdirSync(join(runnerRoot, 'scripts/dev'))
  for (const module of ['state.mjs', 'check-graph.mjs', 'protection.mjs']) writeFileSync(join(runnerRoot, 'scripts/dev', module), readFileSync(`scripts/dev/${module}`))
  writeFileSync(join(runnerRoot, '.env.example'), readFileSync('.env.example'))
  writeFileSync(join(runnerRoot, '.env'), 'LIVE_SECRET=must-not-copy')
  writeFileSync(join(runnerRoot, '.env.local'), 'LOCAL_SECRET=must-not-copy')
  writeFileSync(join(runnerRoot, 'data/sentinel'), 'original-data')
  writeFileSync(join(runnerRoot, '.ci/checks.json'), JSON.stringify({ static: ['fail', 'after'], runtime: [] }))
  const probe = `const fs=require('fs'); const assert=require('assert'); assert(!fs.existsSync('data/sentinel')); assert(!fs.existsSync('.env.local')); assert(!fs.readFileSync('.env','utf8').includes('must-not-copy')); assert(!process.env.LLM_API_KEY); console.log('isolation-confirmed')`
  writeFileSync(join(runnerRoot, 'scripts/probe.cjs'), probe)
  writeFileSync(join(runnerRoot, 'package.json'), JSON.stringify({ scripts: {
    migrate: 'node scripts/probe.cjs', seed: 'node scripts/probe.cjs',
    fail: 'node -e "process.exit(1)"', after: 'node scripts/probe.cjs',
  } }))
  const run = spawnSync(process.execPath, [join(runnerRoot, 'scripts/ci.mjs'), 'static'], {
    cwd: runnerRoot, encoding: 'utf8', timeout: 30000, env: { ...process.env, LLM_API_KEY: 'fake-live-key' },
  })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ after/, 'a failed check must not suppress subsequent checks')
  assert.equal(readFileSync(join(runnerRoot, 'data/sentinel'), 'utf8'), 'original-data')
  const reports = () => {
    const dirs = (awaitReadDirs)(join(runnerRoot, 'data/ci')).sort()
    return JSON.parse(readFileSync(join(runnerRoot, 'data/ci', dirs.at(-1), 'receipt.json')))
  }
  const fixtureManifest = JSON.parse(readFileSync(join(runnerRoot, 'package.json')))
  fixtureManifest.scripts.slow = 'node -e "setInterval(()=>{},1000)"'
  writeFileSync(join(runnerRoot, 'package.json'), JSON.stringify(fixtureManifest))
  writeFileSync(join(runnerRoot, '.ci/checks.json'), JSON.stringify({ static: [
    { id: 'slow', script: 'slow', timeoutMs: 50, paths: ['*'], resources: [] },
    { id: 'dependent', script: 'after', needs: ['slow'], timeoutMs: 1000, paths: ['*'], resources: [] },
  ], runtime: [] }))
  const timeoutRun = spawnSync(process.execPath, [join(runnerRoot, 'scripts/ci.mjs'), 'static'], { cwd: runnerRoot, encoding: 'utf8', timeout: 15000 })
  assert.equal(timeoutRun.status, 1, timeoutRun.stdout+timeoutRun.stderr)
  const timed = reports(); assert(timed.results.some((r)=>r.timedOut)); assert(timed.results.some((r)=>r.status==='skipped')); assert.equal(timed.complete, false)
  fixtureManifest.scripts.migrate = 'node -e "process.exit(1)"'
  writeFileSync(join(runnerRoot, 'package.json'), JSON.stringify(fixtureManifest))
  const prepRun = spawnSync(process.execPath, [join(runnerRoot, 'scripts/ci.mjs'), 'static'], { cwd: runnerRoot, encoding: 'utf8', timeout: 15000 })
  assert.equal(prepRun.status, 1); assert(reports().results.some((r)=>r.reason==='preparation failed'))
  console.log('✓ CI negative fixtures: layer violations, dynamic imports, scope metrics, document budgets and registered checks')
} finally { rmSync(root, { recursive: true, force: true }) }
