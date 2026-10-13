import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { normalizeGraph, relatedChecks } from './check-graph.mjs'
import { identity, git, assertReceipt, changedPaths } from './state.mjs'
const root = process.cwd()
const [command, id, ...args] = process.argv.slice(2)
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? '')) throw new Error('Use a task id containing lowercase letters, digits and hyphens')
const dir = resolve(root, 'data/dev-tasks', id), path = join(dir, 'task.json')
function expectedChecks(receipt) {
  const graph = normalizeGraph(JSON.parse(readFileSync(join(root, '.ci/checks.json'), 'utf8')))
  return (receipt.mode === 'related' ? relatedChecks(graph, changedPaths(root, receipt.base)) : graph.filter((n) => receipt.mode === 'all' || n.suite === receipt.mode || (receipt.mode === 'docs' && n.script === 'verify:docs'))).map((n) => n.id)
}
function save(task) { mkdirSync(dir, { recursive: true }); writeFileSync(path, JSON.stringify(task, null, 2)+'\n', { mode: 0o600 }) }
if (command === 'create') {
  if (existsSync(path)) throw new Error('Task already exists; resume instead')
  const specification = JSON.parse(readFileSync(args[0], 'utf8'))
  for (const field of ['goal', 'acceptance', 'scope']) if (!specification[field]?.length) throw new Error(`Missing ${field}`)
  const initial = identity(root)
  if (!initial.head) throw new Error('A Git checkout with a committed baseline is required')
  save({ id, specification, base: initial.head, worktree: root, identity: initial, stage: 'planned', remaining: specification.acceptance, checks: [], reviews: [] })
} else {
  const task = JSON.parse(readFileSync(path, 'utf8')), current = identity(root)
  if (task.worktree !== root) throw new Error('Task belongs to another worktree')
  if (command === 'resume') {
    console.log(JSON.stringify({ ...task, stale: task.identity.fingerprint !== current.fingerprint || task.identity.head !== current.head }, null, 2))
  } else if (command === 'checkpoint') {
    const note = JSON.parse(readFileSync(args[0], 'utf8'))
    if (!note.stage || !Array.isArray(note.remaining)) throw new Error('Checkpoint needs stage and remaining')
    task.stage = note.stage; task.remaining = note.remaining; task.notes = note.notes ?? []; task.identity = current; save(task)
  } else if (command === 'attach') {
    const receiptPath = resolve(args[0]), receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assertReceipt(receipt, current, expectedChecks(receipt)); task.checks.push({ path: receiptPath, fingerprint: current.fingerprint, mode: receipt.mode }); save(task)
  } else if (command === 'review') {
    const review = JSON.parse(readFileSync(args[0], 'utf8'))
    if (!review.reviewer || !review.author || review.reviewer === review.author || review.head !== current.head || review.fingerprint !== current.fingerprint || !Array.isArray(review.findings)) throw new Error('Independent, current-version review required')
    task.reviews.push(review); save(task)
  } else if (command === 'release') {
    const receipt = JSON.parse(readFileSync(args[0], 'utf8')); assertReceipt(receipt, current, expectedChecks(receipt))
    if (task.remaining.length) throw new Error('Task acceptance is unfinished; checkpoint remaining work first')
    if (receipt.mode !== 'all') throw new Error('Release preparation requires complete gate')
    if (!task.reviews.some((r) => r.head === current.head && r.fingerprint === current.fingerprint && r.findings.length === 0)) throw new Error('Current independent review with no unresolved findings required')
    console.log(JSON.stringify({ id, fingerprint: current.fingerprint, state: 'prepared-awaiting-human-approval', publish: false }))
  } else if (command === 'worktree') {
    const destination = args[0]
    if (!isAbsolute(destination)) throw new Error('Pass an absolute new worktree directory')
    if (git(root, ['status', '--porcelain']).length) throw new Error('Creating a HEAD worktree from a dirty task would lose its baseline; preserve changes first')
    git(root, ['worktree', 'add', '--detach', destination, task.base])
    const transferred = { ...task, worktree: destination, identity: identity(destination), checks: [], reviews: [] }
    const target = join(destination, 'data/dev-tasks', id); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'task.json'), JSON.stringify(transferred, null, 2)+'\n', { mode: 0o600 }); console.log(destination)
  } else throw new Error('Expected create, resume, checkpoint, attach, review, release or worktree')
}
