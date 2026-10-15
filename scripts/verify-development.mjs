import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { identity, assertReceipt, digest, assertContainedLinks, requireFile, git, changedPaths } from './dev/state.mjs'
import { normalizeGraph, validateGraph, relatedChecks, schedule } from './dev/check-graph.mjs'
import { declaration, linkErrors, generate } from './dev/documents.mjs'
import { assertSurfaceEvidence, bindSurface, transformedAsset } from './dev/browser-surface.mjs'
import { protectedChanges } from './dev/protection.mjs'
import { compatibilityErrors } from './dev/compatibility.mjs'
const projectRoot = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'space-development-'))
try {
  writeFileSync(join(root, 'source.ts'), 'export const value = 1')
  assert.equal(requireFile(root, 'source.ts'), true); assert.equal(requireFile(root, 'absent'), false)
  assert.throws(() => git(root, ['rev-parse', 'HEAD']))
  assert.deepEqual(changedPaths(root, null), [])
  const surface = { expectedOrigin: 'http://127.0.0.1:5172', origin: 'http://127.0.0.1:5172', expectedHash: 'build', receivedHash: 'build', loaded: true }
  assert.doesNotThrow(() => assertSurfaceEvidence(surface))
  assert.throws(() => assertSurfaceEvidence({ ...surface, origin: 'http://127.0.0.1:9999' }), /another port/)
  assert.throws(() => assertSurfaceEvidence({ ...surface, receivedHash: 'another build' }), /differs/)
  assert.throws(() => assertSurfaceEvidence({ ...surface, loaded: false }), /no expected/)
  const initial = identity(root)
  const log = join(root, 'data/probe.log'); mkdirSync(join(root, 'data')); writeFileSync(log, 'passed')
  const receipt = { version: 1, mode: 'all', identity: initial, selected: ['probe'], complete: true, results: [{ id: 'probe', status: 'passed', code: 0, log, logHash: digest('passed') }] }
  assert.doesNotThrow(() => assertReceipt(receipt, initial, ['probe']))
  assert.throws(() => assertReceipt({ ...receipt, version: 99 }, initial, ['probe']), /schema/)
  assert.throws(() => assertReceipt({ ...receipt, selected: ['probe', 'probe'] }, initial, ['probe']), /schema/)
  assert.throws(() => assertReceipt({ ...receipt, results: [{...receipt.results[0], id:'fake'}] }, initial, ['probe']), /Missing/)
  assert.throws(() => assertReceipt({ ...receipt, results: [{...receipt.results[0], timedOut:true}] }, initial, ['probe']), /Missing/)
  assert.throws(() => assertReceipt({ ...receipt, selected: [] }, initial, ['probe']), /empty/)
  assert.throws(() => assertReceipt({ ...receipt, selected: ['fake'] }, initial, ['probe']), /differs/)
  writeFileSync(log, 'altered'); assert.throws(() => assertReceipt(receipt, initial, ['probe']), /altered/); writeFileSync(log, 'passed')
  assert.throws(() => assertReceipt({ ...receipt, complete: false }, initial, ['probe']), /incomplete/)
  for (const status of ['failed', 'skipped', 'aborted']) assert.throws(() => assertReceipt({ ...receipt, results: [{ status }] }, initial, ['probe']))
  writeFileSync(join(root, 'untracked.ts'), 'new file')
  assert.throws(() => assertReceipt(receipt, identity(root), ['probe']), /stale/)
  writeFileSync(join(root, '.env'), 'DO_NOT_READ')
  const withoutSecret = identity(root)
  writeFileSync(join(root, '.env'), 'CHANGED_SECRET')
  assert.equal(identity(root).fingerprint, withoutSecret.fingerprint)
  symlinkSync('source.ts', join(root, 'link.ts')); const linked = identity(root)
  unlinkSync(join(root, 'link.ts')); symlinkSync('untracked.ts', join(root, 'link.ts'))
  assert.notEqual(identity(root).fingerprint, linked.fingerprint)
  assert.doesNotThrow(() => assertContainedLinks(root))
  mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested/local'), 'file'); symlinkSync('absent', join(root, 'broken')); assert.doesNotThrow(() => assertContainedLinks(root)); unlinkSync(join(root, 'broken'))
  symlinkSync('/tmp/escaped-source', join(root, 'escape')); assert.throws(() => assertContainedLinks(root), /absolute/); unlinkSync(join(root, 'escape'))
  symlinkSync(join(root, 'source.ts'), join(root, 'absolute-local')); assert.throws(() => assertContainedLinks(root), /absolute/); unlinkSync(join(root, 'absolute-local'))
  assert(protectedChanges({ checks: { static: ['required'] } }, { checks: { static: [] } }).some((e) => e.includes('removed')))
  assert(protectedChanges({ docs: { budgets: { 'x.md': 100 }, legacyLinks: [] }, quality: { coverage: { module: 1 } } }, { docs: { budgets: { 'x.md': 200 }, legacyLinks: [{path:'x',url:'bad'}] }, quality: { coverage: { module: 0 } } }).length >= 3)
  const graph = normalizeGraph({ static: [
    { id: 'a', script: 'a', resources: ['db'], timeoutMs: 1000, paths: ['src/'] },
    { id: 'b', script: 'b', needs: ['a'], resources: ['db'], timeoutMs: 1000, paths: ['docs/'] },
    { id: 'c', script: 'c', resources: [], timeoutMs: 1000, paths: ['other/'] },
  ] })
  validateGraph(graph, { a: 'a', b: 'b', c: 'c' })
  assert.deepEqual(relatedChecks(graph, ['docs/example.md']).map((n) => n.id), ['a', 'b'])
  assert.throws(() => validateGraph([{ ...graph[0], needs: ['missing'] }], { a: 'a' }), /Missing/)
  assert.throws(() => validateGraph([{ ...graph[0], needs: ['a'] }], { a: 'a' }), /cycle/)
  assert.throws(() => validateGraph([graph[0], graph[0]], { a: 'a' }), /Duplicate/)
  assert.throws(() => validateGraph([{ ...graph[0], timeoutMs: 0 }], { a: 'a' }), /Invalid/)
  const firstScoping = protectedChanges({ checks: { static: [{ ...graph[0], paths: ['*'] }] } }, { checks: { static: [{ ...graph[0], paths: ['src/'] }] } })
  assert.deepEqual(firstScoping, [], 'safe first path mapping is allowed while the full graph remains intact')
  const narrowedScope = protectedChanges({ checks: { static: [{ ...graph[0], paths: ['src/'] }] } }, { checks: { static: [{ ...graph[0], paths: ['src/app/'] }] } })
  assert(narrowedScope.some((error) => error.includes('paths narrowed')), 'later scope narrowing must be blocked')
  const unknownFallback = relatedChecks(graph, ['unmapped/unknown.ts'])
  assert.deepEqual(unknownFallback.map((n) => n.id), graph.map((n) => n.id), 'unknown changes run the entire graph')
  assert(protectedChanges({ docs: { examples: { equivalence: ['required'] } } }, { docs: { examples: { equivalence: [] } } }).length > 0)
  const executed = []
  const failed = await schedule(graph, async (n) => { executed.push(n.id); return { status: n.id === 'a' ? 'failed' : 'passed' } })
  assert.deepEqual(executed.sort(), ['a', 'c']); assert.equal(failed[1].status, 'skipped')
  let active = 0, peak = 0
  await schedule([graph[0], { ...graph[2], resources: ['db'] }], async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return { status: 'passed' } })
  assert.equal(peak, 1, 'same resources cannot overlap')
  assert((await schedule(graph, async () => ({ status: 'passed' }), { cancelled: () => true })).every((r) => r.status === 'aborted'))
  assert.equal((await schedule([graph[0]], async () => { throw Error('failure') }))[0].status, 'failed')
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/good.md'), '# Good\n\n[ok](#good)')
  assert.deepEqual(linkErrors(root), [])
  writeFileSync(join(root, 'docs/bad.md'), '[bad](good.md#missing)')
  assert.equal(linkErrors(root).length, 1)
  const first = declaration('/** contract */\nexport interface Shape { /** field */ value: string }', 'Shape')
  const altered = declaration('/** contract */\ninterface Shape { /** field */ value: number }', 'Shape')
  assert.notDeepEqual(first.structure, altered.structure)
  assert.notDeepEqual(declaration('interface T { /** authorized */ value: string }', 'T').comments, declaration('interface T { /** not authorized */ value: string }', 'T').comments)
  assert.notDeepEqual(first.comments, declaration('/** changed */\ninterface Shape { value: string }', 'Shape').comments)
  assert.throws(() => declaration('interface Other {}', 'Shape'), /Missing/)
  mkdirSync(join(root, '.ci')); mkdirSync(join(root, 'packages/seam/example/src'), { recursive: true })
  const contract = 'packages/seam/example/src/index.ts'; writeFileSync(join(root, contract), 'export interface Shape { value: string }')
  const policy = { sources: { [contract]: digest(readFileSync(join(root, contract))) }, archive: { 'docs/good.md': digest(readFileSync(join(root, 'docs/good.md'))) }, changes: [] }
  writeFileSync(join(root, '.ci/compatibility.json'), JSON.stringify(policy))
  assert.deepEqual(compatibilityErrors(root, policy), [])
  writeFileSync(join(root, contract), 'export interface Shape { value: number }')
  assert.match(compatibilityErrors(root, policy)[0], /acknowledgement|requires/)
  writeFileSync(join(root, 'docs/good.md'), 'corrupted history')
  assert(compatibilityErrors(root, policy).some((e) => e.includes('sealed history')))
  const assetDir = join(root, 'packages/client-ui/example/dist'); mkdirSync(assetDir, { recursive: true })
  writeFileSync(join(root, 'packages/client-ui/example/package.json'), '{}')
  writeFileSync(join(assetDir, 'manifest.json'), JSON.stringify({ entry: { isEntry: true, file: 'entry.js' } }))
  const assetSource = 'import { ref } from "vue"; export const current = ref(1)'
  writeFileSync(join(assetDir, 'entry.js'), assetSource)
  const transformed = await transformedAsset(assetSource, join(assetDir, 'entry.js'), root)
  assert(transformed.includes('/-/vendors/vue'), 'expected asset uses installed WebUI transformation')
  let responseListener, secondFetch = false
  const fakePage = { on(event, callback) { if (event === 'response') responseListener = callback }, url() { return 'http://127.0.0.1:5172/teamspace' }, async goto() { responseListener({ url() { return 'http://127.0.0.1:5172/entry.js' }, async body() { return Buffer.from('wrong cached build') } }); return {} }, request: { async get() { secondFetch = true; return { body() { return Buffer.from(transformed) } } } } }
  bindSurface(fakePage, 'http://127.0.0.1:5172', root)
  await assert.rejects(() => fakePage.goto('http://127.0.0.1:5172/teamspace'), /differs/)
  assert.equal(secondFetch, false, 'acceptance must inspect actual loaded response, never a replacement fetch')
  if (!process.argv.includes('--coverage-child')) {
    const projectGraph = normalizeGraph(JSON.parse(readFileSync(join(projectRoot, '.ci/checks.json'), 'utf8')))
    const kbRelated = relatedChecks(projectGraph, ['packages/client-ui/space-client-ui-kb/client/index.ts', 'scripts/ui-verify.mjs'])
    const kbRelatedScripts = new Set(kbRelated.map((node) => node.script))
    assert(kbRelatedScripts.has('verify:ui') && kbRelatedScripts.has('check:web'), 'KB UI changes run browser and build consumers')
    assert(!kbRelatedScripts.has('verify:inbox-orchestrator-retry'), 'KB UI changes avoid unrelated inbox database checks')
    assert.equal(relatedChecks(projectGraph, ['new-unmapped-area/file.ts']).length, projectGraph.length, 'unmapped project paths conservatively run the complete graph')
    const cold = spawnSync(process.execPath, ['--input-type=module', '-e', `import {transformedAsset} from ${JSON.stringify(new URL('./dev/browser-surface.mjs', import.meta.url).href)}; await transformedAsset('import {ref} from "vue";', '/tmp/probe.js', ${JSON.stringify(process.cwd())})`], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(cold.status, 0, cold.stderr)
    writeFileSync(join(root, '.gitignore'), 'data/\n')
    writeFileSync(join(root, '.ci/checks.json'), JSON.stringify({ static: [{id:'probe',script:'probe',resources:[],paths:['*'],timeoutMs:1000}], runtime: [] }))
    for (const args of [['init','-q'],['config','user.name','Engineering fixture'],['config','user.email','fixture@example.invalid'],['add','.'],['commit','-qm','synthetic development baseline']]) {
      const command = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(command.status, 0, command.stderr)
    }
    const spec = join(root, 'spec.json'); writeFileSync(spec, JSON.stringify({ goal: 'document probe', acceptance: ['readable'], scope: ['source.ts'] }))
    const taskCLI = new URL('./dev/task.mjs', import.meta.url).pathname
    const run = (...args) => spawnSync(process.execPath, [taskCLI, ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(run('create', 'probe', spec).status, 0)
    assert.notEqual(run('create', 'probe', spec).status, 0, 'duplicate create must not overwrite')
    assert.equal(JSON.parse(run('resume', 'probe').stdout).stale, false)
    writeFileSync(join(root, 'source.ts'), 'changed')
    assert.equal(JSON.parse(run('resume', 'probe').stdout).stale, true)
    const review = join(root, 'data/review.json'); writeFileSync(review, JSON.stringify({ reviewer: 'same', author: 'same', fingerprint: identity(root).fingerprint, findings: [] }))
    assert.notEqual(run('review', 'probe', review).status, 0)
    const checkpoint = join(root, 'data/checkpoint.json')
    writeFileSync(checkpoint, JSON.stringify({stage:'validated',remaining:[],notes:['Documentation and code edits were recovered from a changed fingerprint.']}))
    assert.equal(run('checkpoint','probe',checkpoint).status,0)
    const current = identity(root), validation = join(root, 'data/receipt.json')
    const executed = spawnSync(process.execPath,['-e','const assert=require("node:assert/strict");assert.equal(1+1,2);console.log("behavior passed")'],{encoding:'utf8'})
    assert.equal(executed.status,0);writeFileSync(log,executed.stdout)
    writeFileSync(validation,JSON.stringify({version:1,mode:'all',identity:current,selected:['probe'],complete:true,results:[{id:'probe',status:'passed',code:0,log,logHash:digest(executed.stdout)}]}))
    assert.equal(run('attach','probe',validation).status,0)
    writeFileSync(review,JSON.stringify({reviewer:'independent-fixture-reviewer',author:'fixture-author',head:current.head,fingerprint:current.fingerprint,findings:[]}))
    assert.equal(run('review','probe',review).status,0)
    assert.equal(run('release','probe',validation).status,0,'full evidence prepares release without publishing')
    writeFileSync(join(root,'docs/drill.md'),'# Documentation drill\n')
    assert.equal(JSON.parse(run('resume','probe').stdout).stale,true)
    assert.notEqual(run('attach','probe',validation).status,0,'documentation mutation expires receipt')
    writeFileSync(join(root,'sample.mjs'),'export const plus = (x) => x + 1\n')
    assert.notEqual(run('release','probe',validation).status,0,'code mutation expires release evidence')
    assert.notEqual(run('worktree','probe',join(root,'other-worktree')).status,0,'dirty baseline cannot be silently dropped')

    assert.throws(() => generate(root, true), /Empty|stale/)
  }
  console.log('✓ Development negative probes: stale receipts, failed/skipped/aborted states, graph closure/cycles, locks, links, declaration drift, compatibility, archive and task recovery')
} finally { rmSync(root, { recursive: true, force: true }) }
