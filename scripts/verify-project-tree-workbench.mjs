import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'project-tree-workbench-'))
const fixtureScripts = resolve(fixtureRoot, 'scripts')
const runnerRoot = mkdtempSync(resolve(tmpdir(), 'project-tree-runner-'))
const outsideRoot = mkdtempSync(resolve(tmpdir(), 'project-tree-outside-'))
const serverScript = resolve(runnerRoot, 'project-tree-server.mjs')
let serverProcess

function writeFixture(path, content = '') {
  const absolutePath = resolve(fixtureRoot, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

function git(args) {
  return execFileSync('git', ['-C', fixtureRoot, ...args], { encoding: 'utf8' }).trim()
}

async function startServer() {
  serverProcess = spawn(process.execPath, [serverScript, '--root', fixtureRoot, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk })
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`地图服务启动超时：${output}${errors}`)), 5000)
    serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//)
      if (match) { clearTimeout(timer); resolvePromise(match[0].replace(/\/$/, '')) }
    })
    serverProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`地图服务退出 (${code})：${errors}`)) })
  })
}

try {
  mkdirSync(fixtureScripts, { recursive: true })
  for (const file of ['project-tree-html.mjs', 'project-tree-server.mjs', 'project-tree-atlas.template.html', 'project-tree.metadata.json', 'project-tree.annotations.json']) {
    cpSync(resolve(scriptDirectory, file), resolve(fixtureScripts, file))
    cpSync(resolve(scriptDirectory, file), resolve(runnerRoot, file))
  }
  unlinkSync(resolve(runnerRoot, 'project-tree.annotations.json'))
  execFileSync('git', ['init', '-q', fixtureRoot])
  writeFixture('.gitignore', 'data/\n')
  writeFixture('src/change.ts', 'const value = 1\n')
  writeFixture('src/delete.ts', 'remove me\n')
  writeFixture('src/rename-old.ts', 'rename me\n')
  writeFixture('src/retired.ts', 'this path will later disappear\n')
  git(['config', 'user.email', 'tree-test@example.invalid'])
  git(['config', 'user.name', 'Tree Fixture'])
  git(['add', '.'])
  git(['commit', '-qm', 'fixture baseline'])

  writeFixture('src/change.ts', 'const value = 2\n')
  unlinkSync(resolve(fixtureRoot, 'src/delete.ts'))
  renameSync(resolve(fixtureRoot, 'src/rename-old.ts'), resolve(fixtureRoot, 'src/rename-new.ts'))
  git(['add', '-A'])
  writeFixture('src/new file.ts', 'export const fresh = true\n')
  writeFixture('src/image.bin', Buffer.from([0, 1, 2, 3]))

  const base = await startServer()
  const treeResponse = await fetch(`${base}/api/tree`)
  assert.equal(treeResponse.status, 200)
  const treePayload = await treeResponse.json()
  assert.ok(treePayload.counts.files >= 5, 'tree includes changed, deleted, renamed, and untracked paths')
  const treeText = JSON.stringify(treePayload.tree)
  assert.match(treeText, /src\/delete\.ts/, 'deleted files remain visible in the graph for review')
  assert.match(treeText, /src\/rename-old\.ts/, 'rename source stays visible alongside its destination')
  const crossSite = await fetch(`${base}/api/annotations`, { headers: { origin: 'http://outside.invalid' } })
  assert.equal(crossSite.status, 403, 'cross-origin browser requests are rejected')

  const changesResponse = await fetch(`${base}/api/git/changes`)
  assert.equal(changesResponse.status, 200)
  const changes = (await changesResponse.json()).changes
  assert.ok(changes.some((item) => item.path === 'src/change.ts' && item.kind === 'modified'), 'unstaged modification is visible relative to HEAD')
  assert.ok(changes.some((item) => item.path === 'src/delete.ts' && item.kind === 'deleted'), 'deleted tracked file is visible')
  const rename = changes.find((item) => item.path === 'src/rename-new.ts')
  assert.equal(rename?.kind, 'renamed', 'Git rename is represented explicitly')
  assert.equal(rename?.oldPath, 'src/rename-old.ts')
  assert.ok(changes.some((item) => item.path === 'src/new file.ts' && item.kind === 'untracked'), 'untracked paths with spaces are safe')

  const card = {
    id: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
    title: '改造模块入口',
    instruction: '调整实现并保留契约。',
    status: 'in-progress',
    tags: ['架构', '第一阶段'],
    nodePaths: ['src', 'src/change.ts'],
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  }
  const saveResponse = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [card] }) })
  assert.equal(saveResponse.status, 200, `valid annotation is accepted: ${await saveResponse.clone().text()}`)
  const saved = await (await fetch(`${base}/api/annotations`)).json()
  assert.deepEqual(saved.cards, [card], 'annotations persist and round-trip')
  assert.equal(existsSync(resolve(fixtureScripts, 'project-tree.annotations.json')), true, 'annotations are stored in the target project root')
  assert.equal(existsSync(resolve(runnerRoot, 'project-tree.annotations.json')), false, 'annotations are not written beside the tool script')
  writeFileSync(resolve(fixtureScripts, 'project-tree.annotations.json'), '{"version":9,"cards":[]}\n')
  const malformedResponse = await fetch(`${base}/api/annotations`)
  assert.equal(malformedResponse.status, 500, 'invalid project annotation files return a clear server error')
  assert.match((await malformedResponse.json()).error, /version 1/)
  const restoreResponse = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [card] }) })
  assert.equal(restoreResponse.status, 200, 'valid annotations can repair a malformed document')
  const invalidResponse = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [{ ...card, nodePaths: ['../outside'] }] }) })
  assert.equal(invalidResponse.status, 400, 'paths outside discovered project nodes are rejected')
  assert.deepEqual((await (await fetch(`${base}/api/annotations`)).json()).cards, [card], 'invalid saves leave prior annotation data intact')

  const changedDiff = await (await fetch(`${base}/api/git/diff?path=${encodeURIComponent('src/change.ts')}`)).json()
  assert.match(changedDiff.text, /-const value = 1/)
  assert.match(changedDiff.text, /\+const value = 2/)
  const addedDiff = await (await fetch(`${base}/api/git/diff?path=${encodeURIComponent('src/new file.ts')}`)).json()
  assert.match(addedDiff.text, /\+export const fresh = true/)
  const deletedDiff = await (await fetch(`${base}/api/git/diff?path=${encodeURIComponent('src/delete.ts')}`)).json()
  assert.match(deletedDiff.text, /-remove me/)
  const binaryDiff = await (await fetch(`${base}/api/git/diff?path=${encodeURIComponent('src/image.bin')}`)).json()
  assert.equal(binaryDiff.binary, true, 'binary files report status without text rendering')
  assert.equal(git(['diff', '--cached', '--name-only']).includes('src/rename-new.ts'), true, 'Git comparison remains read-only and staged state is preserved')

  const retiredCard = { ...card, nodePaths: ['src/retired.ts'] }
  const retiredSave = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [retiredCard] }) })
  assert.equal(retiredSave.status, 200)
  git(['add', '-A'])
  git(['commit', '-qm', 'commit workspace diff fixtures'])
  git(['rm', '-q', 'src/retired.ts'])
  git(['commit', '-qm', 'remove annotated file'])
  const staleRead = await fetch(`${base}/api/annotations`)
  assert.equal(staleRead.status, 200, 'committed path removals do not hide the rest of the planning document')
  assert.deepEqual((await staleRead.json()).cards[0].nodePaths, ['src/retired.ts'], 'stale annotations remain available for repair')
  const staleWrite = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [retiredCard] }) })
  assert.equal(staleWrite.status, 400, 'new writes still reject paths absent from the current tree')

  const page = await (await fetch(`${base}/`)).text()
  assert.match(page, /新增规划卡/)
  assert.match(page, /统一格式文件差异/)
  assert.match(page, /src\/change\.ts/)
  assert.equal(readFileSync(resolve(fixtureScripts, 'project-tree.annotations.json'), 'utf8').includes('改造模块入口'), true)

  renameSync(fixtureScripts, resolve(fixtureRoot, 'scripts-internal'))
  symlinkSync(outsideRoot, fixtureScripts, 'dir')
  const symlinkWrite = await fetch(`${base}/api/annotations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, cards: [card] }) })
  assert.equal(symlinkWrite.status, 500, 'annotation writes reject a scripts directory symlink')
  assert.match((await symlinkWrite.json()).error, /scripts 目录/)
  const symlinkRead = await fetch(`${base}/api/annotations`)
  assert.equal(symlinkRead.status, 500, 'annotation reads reject a scripts directory symlink')
  assert.equal(existsSync(resolve(outsideRoot, 'project-tree.annotations.json')), false, 'annotation saves never write outside the project through a symlink')
  unlinkSync(fixtureScripts)
  renameSync(resolve(fixtureRoot, 'scripts-internal'), fixtureScripts)
  const outsideAnnotations = resolve(outsideRoot, 'project-tree.annotations.json')
  writeFileSync(outsideAnnotations, JSON.stringify({ version: 1, cards: [{ ...card, title: '外部秘密' }] }))
  unlinkSync(resolve(fixtureScripts, 'project-tree.annotations.json'))
  symlinkSync(outsideAnnotations, resolve(fixtureScripts, 'project-tree.annotations.json'), 'file')
  const annotationFileSymlinkRead = await fetch(`${base}/api/annotations`)
  assert.equal(annotationFileSymlinkRead.status, 500, 'annotation reads reject a linked JSON file')
  assert.doesNotMatch(await annotationFileSymlinkRead.text(), /外部秘密/, 'linked annotation data is never returned to the browser')

  console.log('项目地图工作台验证通过：规划卡读写与路径保护有效；暂存、未暂存、未跟踪、删除、重命名和二进制文件差异可安全读取。')
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM')
    await new Promise((resolvePromise) => serverProcess.once('exit', resolvePromise))
  }
  rmSync(fixtureRoot, { recursive: true, force: true })
  rmSync(runnerRoot, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}
