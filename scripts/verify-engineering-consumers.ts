import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { composeTo } from '../src/compose.ts'

const origin = process.cwd(), dir = mkdtempSync(resolve('data/engineering-consumer-'))
const ctx = new Context()
let loader: ReturnType<Context['plugin']> | undefined
try {
  const provider = join(dir, 'provider.mjs'), consumer = join(dir, 'consumer.mjs')
  writeFileSync(provider, `export function apply(ctx, config) { ctx.provide('engineeringProbe', { value: config.value }); ctx.effect(() => { globalThis.__engineeringActive = (globalThis.__engineeringActive || 0) + 1; return () => { globalThis.__engineeringActive--; }; }); }`)
  writeFileSync(consumer, `export const inject = ['engineeringProbe']; export function apply(ctx) { globalThis.__engineeringSeen = ctx.engineeringProbe.value; }`)
  const name = pathToFileURL(provider).href, consumeName = pathToFileURL(consumer).href
  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify([{ id: 'provider', name, config: { value: 1, old: true } }, { id: 'consumer', name: consumeName }]))
  ctx.baseUrl = pathToFileURL(origin).href + '/'
  loader = ctx.plugin(Loader)
  await loader
  await ctx.loader.create({ name: '@cordisjs/plugin-include', config: { path: manifest, patches: [{ id: 'provider', config: { value: 2 } }] } })
  await ctx.loader.await()
  assert.equal((globalThis as any).__engineeringSeen, 2, 'consumer must receive real Loader-injected patched service')
  assert.equal((globalThis as any).__engineeringActive, 1)
  await loader?.dispose()
  assert.equal((globalThis as any).__engineeringActive, 0, 'disposer must release resources')

  // Composition is a layer replacement dialect, not Include's patch instruction format.
  mkdirSync(join(dir, 'packages/bundle/base'), { recursive: true }); mkdirSync(join(dir, 'profiles/override'), { recursive: true })
  writeFileSync(join(dir, 'packages/bundle/base/package.json'), JSON.stringify({ cordis: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'packages/bundle/base/cordis.patch.yml'), `- id: probe\n  name: ${name}\n  config:\n    value: 1\n    removed: true\n`)
  writeFileSync(join(dir, 'profiles/override/cordis.patch.yml'), `- id: probe\n  name: ${name}\n  disabled: true\n  config:\n    value: !!js 1 + 1\n`)
  process.chdir(dir); const composed = composeTo('out.yml'); const output = readFileSync(composed.path, 'utf8')
  assert.equal(composed.disabled, 1); assert(!output.includes('removed:'), 'whole-entry replacement must not deep-merge config')
  assert.match(output, /!!js.*1 \+ 1/, 'expression preserved until actual Include evaluation')
  writeFileSync(join(dir, 'profiles/override/cordis.patch.yml'), '- id: probe\n  name: x\n- id: probe\n  name: y\n')
  assert.throws(() => composeTo('bad.yml'), /重复|校验/)
  console.log('✓ Real Loader injection, patch config replacement, lifecycle disposal, compose whole-entry replacement, disabled, expression preservation and duplicate rejection')
} finally { process.chdir(origin); await loader?.dispose(); rmSync(dir, { recursive: true, force: true }) }
