// Every gate runs against disposable source, environment, database and ports.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { identity, changedPaths, git, assertContainedLinks, digest } from './dev/state.mjs'
import { protectedChanges } from './dev/protection.mjs'
import { normalizeGraph, validateGraph, relatedChecks, schedule } from './dev/check-graph.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const mode = process.argv[2] ?? 'all'
if (!['static', 'runtime', 'all', 'related', 'docs'].includes(mode)) throw new Error('Expected static, runtime, all, related or docs')
const checks = JSON.parse(readFileSync(join(root, '.ci/checks.json')))
const sourceIdentity = identity(root)
const base = process.env.CI_BASE_SHA || process.argv[3] || git(root, ['rev-parse', 'HEAD'], null)
const graph = normalizeGraph(checks)
validateGraph(graph, JSON.parse(readFileSync(join(root, 'package.json'))).scripts)
const changed = changedPaths(root, base)
const selected = mode === 'related' ? relatedChecks(graph, changed) : graph.filter((n) => mode === 'all' || n.suite === mode || (mode === 'docs' && n.script === 'verify:docs'))
const checkout = mkdtempSync(join(tmpdir(), 'teamspace-ci-'))
const report = join(root, 'data/ci', `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`)
mkdirSync(report, { recursive: true })
const results = []
const receipt = { version: 1, mode, base, baseSource: process.env.CI_BASE_SHA ? 'platform environment; publisher must ensure trust' : process.argv[3] ? 'explicit local argument (untrusted)' : 'local HEAD', identity: sourceIdentity, selected: selected.map((n) => n.id), changed, complete: false, results }
function persist() { writeFileSync(join(report, 'results.json'), JSON.stringify(results, null, 2) + '\n'); writeFileSync(join(report, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
let cancelled = false
const children = new Set()
// Never forward service credentials or local runtime configuration to the checkout.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'CI', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE'].includes(key)))
env.HOME = join(checkout, 'data/ci-home')
mkdirSync(env.HOME, { recursive: true })
env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.env.HOME || '', '.cache/ms-playwright')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
function child(command, args, log) {
  const proc = spawn(command, args, { cwd: checkout, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(proc)
  proc.on('close', () => children.delete(proc))
  let output = ''
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (data) => {
    output += data
    if (log) writeFileSync(log, output)
  })
  return proc
}
async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const closed = new Promise((done) => proc.once('close', done))
  try { process.kill(-proc.pid, 'SIGTERM') } catch {}
  await Promise.race([closed, delay(3000)])
  if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, 'SIGKILL') } catch {}
    await Promise.race([closed, delay(3000)])
  }
}
async function run(name, command, args, timeoutMs = 180_000) {
  if (cancelled) throw new Error('CI interrupted')
  const start = Date.now()
  const logPath = join(report, `${name.replaceAll(':', '-')}-${start}.log`)
  writeFileSync(logPath, '')
  const proc = child(command, args, logPath)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void stop(proc) }, timeoutMs)
  const code = await new Promise((done) => { proc.once('error', () => done(1)); proc.once('close', done) })
  clearTimeout(timer)
  const ok = code === 0 && !timedOut && !cancelled
  const result = { name, status: cancelled ? 'aborted' : ok ? 'passed' : 'failed', ok, code, timedOut, durationMs: Date.now() - start, log: logPath, logHash: existsSync(logPath) ? digest(readFileSync(logPath)) : null }
  if (existsSync(join(checkout, 'data/database.db'))) {
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(checkout, 'data/database.db'))
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('INSERT INTO action_log(action, detail, ok, created_at) VALUES (?, ?, ?, ?)').run(`ci:${name}`, JSON.stringify({ status: result.status, code, durationMs: result.durationMs, logHash: result.logHash }), result.ok ? 1 : 0, new Date().toISOString()) }
    catch (error) { result.status = 'failed'; result.ok = false; result.recordError = error.message }
    finally { db.close() }
  }
  results.push(result)
  console.log(`${result.ok ? '✓' : '✗'} ${name} (${result.durationMs}ms)`)
  if (!result.ok) {
    const path = logPath
    if (existsSync(path)) console.error(readFileSync(path, 'utf8').split('\n').slice(-18).join('\n'))
  }
  persist()
  return result
}
async function ports() {
  const servers = Array.from({ length: 4 }, () => createServer())
  try {
    await Promise.all(servers.map((server) => new Promise((done, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', done)
    })))
    return servers.map((server) => server.address().port)
  } finally { await Promise.all(servers.map((server) => new Promise((done) => server.close(done)))) }
}
async function execute() {
  assertContainedLinks(root)
  const policy = (name) => { const text = base ? git(root, ['show', `${base}:.ci/${name}.json`], '') : ''; return text ? JSON.parse(text) : null }
  const trusted = { checks: policy('checks'), docs: policy('docs'), quality: policy('quality') }
  const current = Object.fromEntries(['checks', 'docs', 'quality'].map((name) => [name, existsSync(join(root, `.ci/${name}.json`)) ? JSON.parse(readFileSync(join(root, `.ci/${name}.json`), 'utf8')) : null]))
  const policyErrors = protectedChanges(trusted, current)
  receipt.policyBaseline = trusted.checks ? 'trusted-base-policy' : 'first-introduction-requires-independent-review'
  if (policyErrors.length) throw new Error(policyErrors.join('\n'))
  cpSync(root, checkout, { recursive: true, verbatimSymlinks: true, filter(path) {
    const parts = relative(root, path).split('/')
    return !parts.some((part) => ['.git', '.cordis', '.npmrc', 'data', 'node_modules', 'cache', 'dist', 'lib', 'composed.cordis.yml'].includes(part) ||
      (part.startsWith('.env') && part !== '.env.example'))
  } })
  // Copy dependencies with relative workspace symlinks; linking the whole directory would resolve live source.
  cpSync(join(root, 'node_modules'), join(checkout, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  assertContainedLinks(checkout)
  const compatibility = policy('compatibility')
  if (compatibility) { const path = join(checkout, 'data/trusted-compatibility.json'); mkdirSync(join(checkout, 'data'), { recursive: true }); writeFileSync(path, JSON.stringify(compatibility)); env.DEV_TRUSTED_COMPATIBILITY = path }
  const allocated = await ports()
  let text = readFileSync(join(root, '.env.example'), 'utf8')
  const values = { APP_HOST: '127.0.0.1', APP_PORT: allocated[0], DEBUG_PORT: allocated[1],
    CONSOLE_PORT: allocated[2], TEAMSPACE_PORT: allocated[3], NODE_ENV: 'development',
    SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '', EMBED_API_KEY: '', EMBED_BASE_URL: '', EMBED_MODEL: '' }
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    if (!pattern.test(text)) throw new Error(`Missing template setting ${key}`)
    text = text.replace(pattern, `${key}=${value}`)
  }
  writeFileSync(join(checkout, '.env'), text, { mode: 0o600 })
  if (identity(checkout).fingerprint !== sourceIdentity.fingerprint) throw new Error('Copied checkout differs from validation identity')
  if (identity(root).fingerprint !== sourceIdentity.fingerprint) throw new Error('Source changed during isolation copy')
  if (mode !== 'docs' && (!(await run('migrate', 'npm', ['run', 'migrate'])).ok || !(await run('seed', 'npm', ['run', 'seed'])).ok)) return
  const executeNode = async (n) => {
    const result = await run(n.script, 'npm', ['run', n.script], n.timeoutMs); result.id = n.id; return result
  }
  const staticResults = await schedule(selected.filter((n) => n.suite === 'static'), executeNode, { concurrency: 2, cancelled: () => cancelled })
  for (const r of staticResults) if (r.status === 'skipped' || r.status === 'aborted') results.push(r)
  if (!selected.some((n) => n.suite === 'runtime')) return
  if (!(await run('ci:fixtures', process.execPath, ['scripts/ci-fixtures.mjs'])).ok) return
  if (!(await run('build:web', 'npm', ['run', 'build:web'])).ok) return
  const service = child(process.execPath, ['--env-file=.env', '--import', 'tsx', 'src/index.ts'], join(report, 'service.log'))
  const readyUntil = Date.now() + 60_000
  let ready = false
  while (!cancelled && Date.now() < readyUntil && service.exitCode === null) {
    try {
      ready = (await Promise.all([
        `http://127.0.0.1:${values.APP_PORT}/healthz`,
        `http://127.0.0.1:${values.DEBUG_PORT}/`,
        `http://127.0.0.1:${values.TEAMSPACE_PORT}/`,
      ].map(async (url) => (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok))).every(Boolean)
      if (ready) break
    } catch {}
    await delay(250)
  }
  if (!ready) { results.push({ name: 'startup', status: cancelled ? 'aborted' : 'failed', ok: false }); return }
  const runtimeResults = await schedule(selected.filter((n) => n.suite === 'runtime'), executeNode, { concurrency: 1, cancelled: () => cancelled })
  for (const r of runtimeResults) if (r.status === 'skipped' || r.status === 'aborted') results.push(r)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cancelled = true
  process.exitCode = 1
  void Promise.all([...children].map(stop))
})
try { await execute() } catch (error) {
  console.error(error.message)
  results.push({ name: 'environment', status: cancelled ? 'aborted' : 'failed', ok: false, error: error.message })
} finally {
  await Promise.all([...children].map(stop))
  for (const n of selected) if (!results.some((r) => r.name === n.script && !r.setup)) results.push({ id: n.id, name: n.script, status: cancelled ? 'aborted' : 'skipped', ok: false, reason: 'preparation failed' })
  if (identity(root).fingerprint !== sourceIdentity.fingerprint) results.push({ name: 'identity', status: 'failed', ok: false, error: 'Source changed during validation' })
  receipt.complete = results.length > 0 && results.every((r) => r.status === 'passed')
  persist()
  console.log(`CI results: ${report}`)
  rmSync(checkout, { recursive: true, force: true })
}
if (!results.length || results.some((result) => !result.ok)) process.exitCode = 1
