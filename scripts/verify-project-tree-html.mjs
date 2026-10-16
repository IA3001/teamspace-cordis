import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'project-tree-html-'))
const fixtureScripts = resolve(fixtureRoot, 'scripts')
const output = resolve(fixtureRoot, 'data/dev/project-tree.html')

function writeFixture(path, content = '') {
  const absolutePath = resolve(fixtureRoot, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

try {
  mkdirSync(fixtureScripts, { recursive: true })
  cpSync(resolve(scriptDirectory, 'project-tree-html.mjs'), resolve(fixtureScripts, 'project-tree-html.mjs'))
  cpSync(resolve(scriptDirectory, 'project-tree-atlas.template.html'), resolve(fixtureScripts, 'project-tree-atlas.template.html'))
  const metadata = JSON.parse(readFileSync(resolve(scriptDirectory, 'project-tree.metadata.json'), 'utf8'))
  metadata.modules.unshift({
    id: 'fixture-module',
    label: '测试新模块',
    color: '#12ab34',
    paths: ['plugins/demo-plugin'],
    description: '新模块的职责说明来自元数据配置。',
  })
  metadata.fileDescriptions['plugins/demo-plugin/index.ts'] = '新文件的专属说明来自元数据配置。'
  writeFileSync(resolve(fixtureScripts, 'project-tree.metadata.json'), JSON.stringify(metadata, null, 2))

  execFileSync('git', ['init', '-q', fixtureRoot])
  writeFixture('.gitignore', 'node_modules/\ndata/\n')
  writeFixture('.env', 'must not appear')
  writeFixture('.env.example', 'safe example path')
  writeFixture('plugins/demo-plugin/index.ts', 'module source')
  writeFixture('packages/seam/new-capability/src/index.ts', 'new file without metadata edits')
  writeFixture('node_modules/hidden.js', 'dependency')
  writeFixture('data/private.db', 'runtime data')

  execFileSync(process.execPath, [resolve(fixtureScripts, 'project-tree-html.mjs'), '--root', fixtureRoot, '--out', output], { stdio: 'pipe' })
  const html = readFileSync(output, 'utf8')

  assert.match(html, /packages\/seam\/new-capability\/src\/index\.ts/, 'new files appear without generator changes')
  assert.match(html, /新模块的职责说明来自元数据配置。/, 'module descriptions are configurable outside the generator')
  assert.match(html, /新文件的专属说明来自元数据配置。/, 'file descriptions are configurable outside the generator')
  assert.match(html, /不负责具体数据库操作/, 'unmapped capability entry files still get a plain-language explanation')
  assert.match(html, /"color":"#12ab34"/, 'new colors are generated directly from metadata')
  assert.match(html, /stroke: color/, 'module colors are applied to nodes and branch connectors')
  assert.match(html, /function renderGraph\(\)/, 'the generated startup script lays out graph nodes')
  assert.match(html, /\.env\.example/, 'the safe env template remains visible')
  assert.doesNotMatch(html, /"path":"\.env"/, 'local env files are excluded')
  assert.doesNotMatch(html, /node_modules\/hidden\.js/, 'git-ignored dependency files are excluded')
  assert.doesNotMatch(html, /data\/private\.db/, 'runtime databases are excluded')
  assert.match(html, /<svg id="graph"/, 'the generated page renders the hierarchy on a graph canvas')
  assert.match(html, /展开一层/, 'the generated page contains graph expansion controls')
  assert.match(html, /pointerdown/, 'the generated canvas supports dragging')

  console.log('项目文件树验证通过：新增路径自动发现，模块/文件描述与颜色由元数据驱动，忽略与敏感文件不会进入页面。')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
