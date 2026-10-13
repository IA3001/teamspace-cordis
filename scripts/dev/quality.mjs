import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { files, digest } from './state.mjs'
import { ast, visit } from './documents.mjs'
export function clones(root) {
  const groups = new Map()
  for (const path of files(root).filter((p) => /^(plugins|packages|src)\//.test(p) && /\.ts$/.test(p) && !/(test|verify)/.test(p))) {
    const source = readFileSync(join(root, path), 'utf8')
    visit(ast(source), (n) => {
      if (!['FunctionDeclaration', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(n.type) || !n.body || n.loc.end.line - n.loc.start.line < 15) return
      const text = source.slice(n.body.start, n.body.end).replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '')
      const hash = digest(text), id = `${path}:${n.id?.name ?? n.key?.name ?? n.loc.start.line}`
      groups.set(hash, [...(groups.get(hash) ?? []), id])
    })
  }
  return Object.fromEntries([...groups].filter(([, paths]) => paths.length > 1).sort())
}
export function qualityErrors(current, baseline) {
  return Object.entries(current).filter(([hash, paths]) => paths.length > (baseline[hash]?.length ?? 1)).map(([hash, paths]) => `New duplicated function block ${hash}: ${paths.join(', ')}`)
}
export function measuredCoverage(root) {
  const folder = join(root, 'data/development-coverage')
  rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true })
  const result = spawnSync(process.execPath, ['scripts/verify-development.mjs', '--coverage-child'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: folder }, timeout: 60000 })
  if (result.status !== 0) throw new Error(`Coverage behavior tests failed: ${result.stdout}${result.stderr}`)
  const summary = {}
  for (const name of readdirSync(folder)) {
    const report = JSON.parse(readFileSync(join(folder, name), 'utf8'))
    for (const script of report.result) {
      if (!script.url.endsWith('/scripts/dev/state.mjs') && !script.url.endsWith('/scripts/dev/check-graph.mjs')) continue
      const path = script.url.endsWith('state.mjs') ? 'state.mjs' : 'check-graph.mjs'
      const ranges = script.functions.flatMap((f) => f.ranges)
      const hit = ranges.filter((r) => r.count > 0).length
      summary[path] = Math.min(summary[path] ?? 1, hit / ranges.length)
    }
  }
  if (Object.keys(summary).length !== 2) throw new Error('Coverage did not include both protected development modules')
  writeFileSync(join(folder, 'summary.json'), JSON.stringify(summary, null, 2)+'\n')
  return summary
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = process.cwd(), config = JSON.parse(readFileSync(join(root, '.ci/quality.json'), 'utf8'))
  const errors = qualityErrors(clones(root), config.clones), coverage = measuredCoverage(root)
  for (const [path, score] of Object.entries(coverage)) if (score < config.coverage[path]) errors.push(`${path}: V8 exercised-range coverage ${score} below baseline ${config.coverage[path]}`)
  errors.forEach((e) => console.error(e)); console.log(JSON.stringify({ coverage, errors: errors.length }))
  process.exitCode = errors.length ? 1 : 0
}
