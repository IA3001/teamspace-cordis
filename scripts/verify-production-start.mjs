// Build and start an isolated production release with an immutable checkout.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = mkdtempSync(join(tmpdir(), 'teamspace-production-start-'))
let child
let childClosed
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

async function stopChild() {
  const running = child
  if (!running || running.exitCode !== null || running.signalCode !== null) {
    child = undefined
    return
  }
  try { process.kill(-running.pid, 'SIGTERM') } catch { /* process group may already be gone */ }
  await Promise.race([childClosed, delay(10_000)])
  if (running.exitCode === null && running.signalCode === null) {
    try { process.kill(-running.pid, 'SIGKILL') } catch { /* process group may already be gone */ }
  }
  child = undefined
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function setEnv(text, name, value) {
  const line = new RegExp(`^${name}=.*$`, 'm')
  assert.match(text, line, `.env.example must define ${name}`)
  return text.replace(line, `${name}=${value}`)
}

function setTreeMode(path, transform) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  chmodSync(path, transform(stat.mode))
  if (stat.isDirectory()) for (const entry of readdirSync(path)) setTreeMode(join(path, entry), transform)
}

function makeWritable(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o600))
  if (stat.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry))
}

function treeDigest(directory) {
  const entries = []
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      const rel = relative(checkout, full)
      if (rel === 'data' || rel.startsWith(`data/`) || rel === 'node_modules' || rel === 'composed.cordis.yml') continue
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(full)
      else entries.push([rel, createHash('sha256').update(readFileSync(full)).digest('hex')])
    }
  }
  walk(directory)
  return JSON.stringify(entries)
}

try {
  // Copy the checkout and its workspace-linked dependencies. Keeping node_modules
  // inside the temp tree makes the read-only permission check representative.
  const binaryArchive = spawnSync('tar', ['-cf', '-', '--exclude=./.git', '--exclude=./node_modules', '--exclude=./data', '.'], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
  })
  if (binaryArchive.status !== 0) throw new Error(`tar failed: ${binaryArchive.stderr}`)
  run('tar', ['-xf', '-', '-C', checkout], { input: binaryArchive.stdout })
  cpSync(join(root, 'node_modules'), join(checkout, 'node_modules'), {
    recursive: true, force: true, verbatimSymlinks: true,
  })
  mkdirSync(join(checkout, 'data', 'workdirs'), { recursive: true })

  const ports = await Promise.all([freePort(), freePort(), freePort()])
  let env = readFileSync(join(checkout, '.env.example'), 'utf8')
  for (const [name, value] of [
    ['APP_HOST', '127.0.0.1'], ['APP_PORT', ports[0]], ['DEBUG_PORT', ports[1]],
    ['TEAMSPACE_PORT', ports[2]], ['NODE_ENV', 'production'],
    ['SETTINGS_ENCRYPTION_KEY', randomBytes(32).toString('base64')],
  ]) env = setEnv(env, name, value)
  writeFileSync(join(checkout, '.env'), env, { mode: 0o600 })

  run('npm', ['run', 'migrate'], { cwd: checkout, maxBuffer: 8 * 1024 * 1024 })
  run('npm', ['run', 'prepare:release'], { cwd: checkout, maxBuffer: 16 * 1024 * 1024 })
  assert(existsSync(join(checkout, 'composed.cordis.yml')), 'release composition must exist')

  const quotaProbe = `quota-ui-${randomBytes(6).toString('hex')}`
  const logsDb = new DatabaseSync(join(checkout, 'data', 'logs.db'))
  try {
    logsDb.exec(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sn INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      level INTEGER NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      entry_id TEXT
    )`)
    logsDb.prepare(`INSERT INTO logs (sn, ts, type, level, name, body, entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      1, Date.now(), 'error', 3, 'sandbox-tools', `[workdir-quota] ${quotaProbe} synthetic isolated UI acceptance`, null,
    )
  } finally {
    logsDb.close()
  }

  setTreeMode(checkout, (mode) => mode & ~0o222)
  makeWritable(join(checkout, 'data'))
  chmodSync(join(checkout, 'composed.cordis.yml'), 0o600)
  const before = treeDigest(checkout)
  assert.equal((lstatSync(checkout).mode & 0o222), 0, 'checkout root must be read-only')
  assert.equal((lstatSync(join(checkout, 'src', 'index.ts')).mode & 0o222), 0, 'source files must be read-only')
  assert.equal((lstatSync(join(checkout, 'node_modules')).mode & 0o222), 0, 'dependencies must be read-only')

  child = spawn('npm', ['start'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  childClosed = new Promise((resolveClose) => child.once('close', resolveClose))
  const checks = [
    ['API health', `http://127.0.0.1:${ports[0]}/healthz`],
    ['Teamspace', `http://127.0.0.1:${ports[2]}/teamspace`],
    ['debug console', `http://127.0.0.1:${ports[1]}/`],
  ]
  for (const [label, url] of checks) {
    const deadline = Date.now() + 30_000
    let response
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`production process exited before ${label}:\n${output}`)
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(1200) })
        if (response.status === 200) break
      } catch { /* wait for the isolated release to finish booting */ }
      await delay(100)
    }
    assert.equal(response?.status, 200, `${label} did not return HTTP 200; output:\n${output}`)
  }

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {})
  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(`http://127.0.0.1:${ports[1]}/logs`, { waitUntil: 'networkidle', timeout: 20000 })
    const search = page.locator('input.search-input')
    await search.waitFor({ timeout: 10000 })
    await search.fill('[workdir-quota]')
    await page.waitForFunction((marker) =>
      [...document.querySelectorAll('.log-list code')].some((row) => row.innerText.includes(marker)), quotaProbe,
    { timeout: 10000 })
    const visibleLogs = await page.locator('.log-list code').allTextContents()
    assert.ok(visibleLogs.some((line) => line.includes(quotaProbe)),
      'the isolated logger UI must find the synthetic [workdir-quota] record')
    assert.deepEqual(pageErrors, [], 'the isolated logger page must not emit browser errors')
    console.log('✓ Isolated Cordis logger UI searches and displays a synthetic [workdir-quota] record')
  } finally {
    await browser.close()
  }
  assert.equal(treeDigest(checkout), before, 'production startup must not modify checkout source or build artifacts')
  await stopChild()
  chmodSync(join(checkout, 'composed.cordis.yml'), 0o400)
  const rejected = spawnSync('npm', ['start'], { cwd: checkout, encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(rejected.status, 0, 'production startup must reject a read-only composed manifest')
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /组合清单不存在或不可写/u,
    'production startup should explain that the generated manifest must be writable')
  assert.equal(treeDigest(checkout), before, 'failed startup preflight must not modify source or artifacts')
  console.log('✓ Production release starts read-only, serves all entry pages, preserves source, and rejects an unwritable manifest')
} finally {
  await stopChild()
  makeWritable(checkout)
  rmSync(checkout, { recursive: true, force: true })
}
