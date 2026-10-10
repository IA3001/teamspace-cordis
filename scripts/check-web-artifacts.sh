#!/usr/bin/env bash
# Validate release-time UI artifacts without rebuilding or mutating the checkout.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/web-pages.sh"

for page in "${WEB_PAGES[@]}"; do
  directory="$REPO_ROOT/packages/client-ui/$page"
  node --input-type=module - "$directory" <<'NODE'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

const directory = process.argv[2]
const dist = resolve(directory, 'dist')
const manifestPath = resolve(dist, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entries = Object.values(manifest).filter((item) => item?.isEntry)
if (entries.length === 0) throw new Error(`no entry in ${manifestPath}`)
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk || typeof chunk !== 'object') throw new Error(`invalid chunk ${key} in ${manifestPath}`)
  for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
    if (!(dependency in manifest)) throw new Error(`missing manifest dependency ${dependency} in ${manifestPath}`)
  }
  for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    if (typeof file !== 'string' || isAbsolute(file)) throw new Error(`invalid asset path in ${manifestPath}`)
    const asset = resolve(dist, file)
    if (!asset.startsWith(`${dist}${sep}`) || !existsSync(asset)) throw new Error(`missing or invalid asset ${file} in ${manifestPath}`)
  }
}
console.log(`✓ ${directory.split('/').at(-1)} release assets verified`)
NODE
done
