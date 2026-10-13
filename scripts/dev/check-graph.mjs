export function normalizeGraph(manifest) {
  const nodes = []
  for (const [suite, checks] of Object.entries(manifest)) {
    checks.forEach((entry, index) => nodes.push(typeof entry === 'string'
      ? { id: `${suite}:${index}:${entry}`, script: entry, needs: [], resources: ['database'], paths: ['*'], timeoutMs: suite === 'runtime' ? 600000 : 180000, suite }
      : { needs: [], resources: [], paths: ['*'], timeoutMs: suite === 'runtime' ? 600000 : 180000, ...entry, suite }))
  }
  return nodes
}
export function validateGraph(nodes, scripts) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (byId.size !== nodes.length) throw new Error('Duplicate check id')
  const done = new Set(), active = new Set()
  function visit(n) {
    if (active.has(n.id)) throw new Error(`Check dependency cycle: ${n.id}`)
    if (done.has(n.id)) return
    if (!scripts[n.script] || !Number.isFinite(n.timeoutMs) || n.timeoutMs <= 0 || !Array.isArray(n.paths) || !n.paths.length || !Array.isArray(n.resources)) throw new Error(`Invalid check: ${n.id}`)
    active.add(n.id)
    for (const id of n.needs) { if (!byId.has(id)) throw new Error(`Missing dependency ${id}`); visit(byId.get(id)) }
    active.delete(n.id); done.add(n.id)
  }
  nodes.forEach(visit)
}
export function relatedChecks(nodes, paths) {
  const selected = new Set(nodes.filter((n) => n.paths.some((scope) => scope === '*' || paths.some((p) => p === scope || p.startsWith(scope)))).map((n) => n.id))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  function add(id) { for (const dep of byId.get(id).needs) if (!selected.has(dep)) { selected.add(dep); add(dep) } }
  ;[...selected].forEach(add)
  return nodes.filter((n) => selected.has(n.id))
}
export async function schedule(nodes, execute, { concurrency = 2, cancelled = () => false } = {}) {
  const pending = new Map(nodes.map((n) => [n.id, n])), results = new Map(), running = new Map(), locks = new Set()
  function finish(n, result) { results.set(n.id, { ...result, id: n.id, name: n.script }); n.resources.forEach((r) => locks.delete(r)); running.delete(n.id) }
  while (pending.size || running.size) {
    for (const [id, n] of pending) {
      if (cancelled()) { results.set(id, { id, name: n.script, status: 'aborted', ok: false }); pending.delete(id); continue }
      const deps = n.needs.map((d) => results.get(d))
      if (deps.some((d) => d && d.status !== 'passed')) { results.set(id, { id, name: n.script, status: 'skipped', ok: false, reason: 'dependency failed' }); pending.delete(id); continue }
      if (deps.some((d) => !d) || running.size >= concurrency || n.resources.some((r) => locks.has(r))) continue
      pending.delete(id); n.resources.forEach((r) => locks.add(r))
      const promise = Promise.resolve().then(() => execute(n)).catch((error) => ({ status: 'failed', ok: false, error: error.message })).then((result) => finish(n, result))
      running.set(id, promise)
    }
    if (running.size) await Promise.race(running.values())
    else if (pending.size) throw new Error('Unresolvable check dependencies')
  }
  return nodes.map((n) => results.get(n.id))
}
