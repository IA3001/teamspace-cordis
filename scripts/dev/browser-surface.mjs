import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import NodeWebUI from '@cordisjs/plugin-webui'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { digest, files } from './state.mjs'
export function assertSurfaceEvidence({ expectedOrigin, origin, expectedHash, receivedHash, loaded }) {
  assert.equal(origin, expectedOrigin, 'browser reached another port/origin')
  assert(loaded, 'no expected application build asset loaded')
  assert.equal(receivedHash, expectedHash, 'served build differs from inspected checkout')
}
async function lexerReady() {
  const require = createRequire(import.meta.resolve('@cordisjs/plugin-webui'))
  const folder = resolve(dirname(require.resolve('es-module-lexer')), '..')
  const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  const lexer = await import(pathToFileURL(resolve(folder, pkg.exports['.'].import)).href)
  await lexer.init
}
export async function transformedAsset(source, filename, root, uiPath = '') {
  await lexerReady()
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../dist/manifest.json', import.meta.resolve('@cordisjs/plugin-webui'))), 'utf8'))
  const receiver = { _manifest: manifest, config: { uiPath }, _warnedAliases: new Set(), ctx: { baseUrl: pathToFileURL(root).href+'/', logger: { warn() {} } } }
  return NodeWebUI.prototype.transformImport.call(receiver, source, filename)
}
export function bindSurface(page, expectedOrigin, root) {
  const manifests = files(root, 'package.json').filter((p) => p.startsWith('packages/client-ui/'))
  const expected = []
  for (const path of manifests) {
    const dist = join(root, path.slice(0, -'package.json'.length), 'dist'), manifest = join(dist, 'manifest.json')
    if (!existsSync(manifest)) continue
    for (const entry of Object.values(JSON.parse(readFileSync(manifest, 'utf8')))) if (entry.isEntry) expected.push({ file: entry.file, path: join(dist, entry.file), source: readFileSync(join(dist, entry.file), 'utf8') })
  }
  if (!expected.length) throw new Error('No application release manifests for browser acceptance')
  let generation = 0
  const seen = new Map()
  page.on('response', (response) => {
    const url = new URL(response.url())
    const entry = expected.find((asset) => url.origin === expectedOrigin && url.pathname.endsWith('/'+asset.file))
    if (!entry) return
    const version = generation
    const body = response.body().then((value) => ({ hash: digest(value), version, entry })).catch((error) => ({ error, version, entry }))
    seen.set(url.href, body)
  })
  const goto = page.goto.bind(page)
  page.goto = async (...args) => {
    generation++; seen.clear()
    const response = await goto(...args)
    const origin = new URL(page.url()).origin
    assert.equal(origin, expectedOrigin, 'navigation changed the accepted origin')
    const captures = (await Promise.all(seen.values())).filter((capture) => capture.version === generation)
    assert(captures.length, 'page did not actually load an expected application entry response')
    for (const capture of captures) {
      if (capture.error) throw capture.error
      assertSurfaceEvidence({ expectedOrigin, origin, expectedHash: digest(await transformedAsset(capture.entry.source, capture.entry.path, root)), receivedHash: capture.hash, loaded: true })
    }
    return response
  }
}
