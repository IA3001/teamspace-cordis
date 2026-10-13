import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'

export const digest = (value) => createHash('sha256').update(value).digest('hex')
export function git(root, args, fallback) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch (error) { if (fallback !== undefined) return fallback; throw error }
}
export function files(root, suffix = '') {
  const out = []
  const excluded = new Set(['.git', '.cordis', 'node_modules', 'data', 'cache', 'dist', 'lib', '__pycache__'])
  function walk(dir, prefix) {
    for (const name of readdirSync(dir).sort()) {
      if (excluded.has(name) || (name.startsWith('.env') && name !== '.env.example') || name === 'composed.cordis.yml' || name === '.npmrc') continue
      const path = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(join(dir, name))
      if (stat.isSymbolicLink()) { if (path.endsWith(suffix)) out.push(path); continue }
      if (stat.isDirectory()) walk(join(dir, name), path)
      else if (path.endsWith(suffix) && !/\.(db|log|pyc)$/.test(path)) out.push(path)
    }
  }
  walk(root, '')
  return out
}
export function identity(root) {
  const entries = files(root).map((path) => [path, lstatSync(join(root, path)).mode & 0o111, digest(lstatSync(join(root, path)).isSymbolicLink() ? `symlink:${readlinkSync(join(root, path))}` : readFileSync(join(root, path)))])
  return { head: git(root, ['rev-parse', 'HEAD'], null), fingerprint: digest(JSON.stringify(entries)), entries }
}
export function changedPaths(root, base) {
  const committed = base ? git(root, ['diff', '--name-only', base, 'HEAD', '--'], '') : ''
  const dirty = git(root, ['diff', '--name-only', 'HEAD', '--'], '')
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'], '')
  return [...new Set(`${committed}\n${dirty}\n${untracked}`.split('\n').filter(Boolean))].sort()
}
export function assertReceipt(receipt, current, required) {
  if (receipt.identity?.fingerprint !== current.fingerprint || receipt.identity?.head !== current.head) throw new Error('Validation receipt is stale for this checkout')
  if (receipt.version !== 1 || !['all', 'static', 'runtime', 'related', 'docs'].includes(receipt.mode) || !Array.isArray(required) || !required.length || !Array.isArray(receipt.selected) || !receipt.selected.length || new Set(receipt.selected).size !== receipt.selected.length) throw new Error('Invalid validation schema or empty check selection')
  if (JSON.stringify([...receipt.selected].sort()) !== JSON.stringify([...required].sort())) throw new Error('Validation selection differs from required current checks')
  if (!receipt.complete || !receipt.results?.length || receipt.results.some((r) => r.status !== 'passed')) throw new Error('Validation is incomplete or unsuccessful')
  for (const id of required) {
    const matches = receipt.results.filter((r) => r.id === id)
    if (matches.length !== 1 || matches[0].code !== 0 || matches[0].timedOut || !matches[0].log || !matches[0].logHash || !existsSync(matches[0].log) || digest(readFileSync(matches[0].log)) !== matches[0].logHash) throw new Error(`Missing, invalid or altered check evidence: ${id}`)
  }
}
export function requireFile(root, path) { return existsSync(join(root, path)) }

export function assertContainedLinks(root, directory = root) {
  for (const name of readdirSync(directory)) {
    if (['.git', 'data', 'cache', 'dist', 'lib'].includes(name) || name.startsWith('.env')) continue
    const path = join(directory, name), stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path))) throw new Error(`Isolation rejects absolute symlink: ${relative(root, path)}`)
      const target = resolve(directory, readlinkSync(path)), inside = relative(root, target)
      if (inside === '..' || inside.startsWith('../')) throw new Error(`Isolation rejects escaping symlink: ${relative(root, path)}`)
      if (existsSync(path)) { const final = relative(root, realpathSync(path)); if (final === '..' || final.startsWith('../')) throw new Error(`Isolation rejects indirect escaping symlink: ${relative(root, path)}`) }
    } else if (stat.isDirectory()) assertContainedLinks(root, path)
  }
}
