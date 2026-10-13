export function protectedChanges(before, after) {
  const errors = []
  const oldNodes = Object.values(before.checks ?? {}).flat().map((n) => typeof n === 'string' ? n : n.script)
  const newNodes = new Set(Object.values(after.checks ?? {}).flat().map((n) => typeof n === 'string' ? n : n.script))
  for (const script of oldNodes) if (!newNodes.has(script)) errors.push(`Protected check removed: ${script}; requires independently approved policy change before implementation`)
  for (const [path, ceiling] of Object.entries(before.docs?.budgets ?? {})) if (!(path in (after.docs?.budgets ?? {})) || after.docs.budgets[path] > ceiling) errors.push(`Documentation budget weakened: ${path}`)
  for (const error of before.docs ? (after.docs?.legacyLinks ?? []) : []) if (!(before.docs?.legacyLinks ?? []).some((e) => JSON.stringify(e) === JSON.stringify(error))) errors.push(`Link exemption expanded: ${error.path} ${error.url}`)
  for (const [path, score] of Object.entries(before.quality?.coverage ?? {})) if ((after.quality?.coverage?.[path] ?? -1) < score) errors.push(`Coverage baseline lowered: ${path}`)
  for (const [hash, entries] of Object.entries(before.quality ? (after.quality?.clones ?? {}) : {})) if (entries.length > (before.quality?.clones?.[hash]?.length ?? 1)) errors.push(`Duplicate-code baseline expanded: ${hash}`)
  for (const [suite, nodes] of Object.entries(before.checks ?? {})) for (const old of nodes.filter((n) => typeof n !== 'string')) {
    const current = (after.checks?.[suite] ?? []).find((n) => n.id === old.id)
    if (!current) { errors.push(`Check identity/suite changed: ${old.id}`); continue }
    for (const field of ['script', 'paths', 'needs', 'resources']) if (JSON.stringify(current[field] ?? []) !== JSON.stringify(old[field] ?? [])) errors.push(`Protected check ${field} changed: ${old.id}`)
  }
  if (before.docs?.examples && JSON.stringify(before.docs.examples) !== JSON.stringify(after.docs?.examples)) errors.push('Protected public example/equivalence manifest changed')
  if (before.quality?.scope && before.quality.scope !== after.quality?.scope) errors.push('Protected coverage/duplication scope changed')
  return errors
}
