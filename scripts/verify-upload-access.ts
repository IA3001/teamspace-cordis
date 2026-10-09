import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugins/space-upload/index.ts'

const root = mkdtempSync(join(tmpdir(), 'teamspace-upload-access-'))
const routes = new Map<string, (req: any) => Promise<Response>>()
const files = new Map<string, Record<string, unknown>>()
const documents: Array<{ id: string; title: string; source: string; text: string }> = []
const timeline: unknown[] = []
const users = new Map([
  ['token-a', { id: 'u_a', kind: 'human' }],
  ['token-b', { id: 'u_b', kind: 'human' }],
  ['token-agent', { id: 'a_agent', kind: 'agent' }],
])
const ctx = {
  server: {
    post(path: string, handler: (req: any) => Promise<Response>) { routes.set(path, handler) },
    get(path: string, handler: (req: any) => Promise<Response>) { routes.set(path, handler) },
  },
  users: { async verifyToken(token: string) { const user = users.get(token); if (!user) throw new Error('unauthorized'); return user } },
  session: {
    getSession(id: string) { return ['s-a', 's-b'].includes(id) ? { id } : null },
    listMembers(id: string) { return id === 's-a' ? [{ principalId: 'u_a' }] : [{ principalId: 'u_b' }] },
  },
  database: {
    async create(_table: string, row: Record<string, unknown>) { files.set(String(row.stored_name), row); return row },
    async get(_table: string, query: Record<string, unknown>) {
      const row = files.get(String(query.stored_name))
      return row ? [row] : []
    },
  },
  kb: {
    async listDocuments() { return documents.map(({ id, title, source }) => ({ id, title, source, size: 0, createdAt: '', chunkCount: 0 })) },
    async addDocument(title: string, text: string, source: string) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const row = { id: `doc-${documents.length + 1}`, title, source, text }
      documents.push(row)
      return row
    },
  },
  eventLog: { append(event: unknown) { timeline.push(event) } },
} as never

apply(ctx, { dir: root })
const upload = routes.get('/api/upload')!
const download = routes.get('/api/uploads/:name')!
const request = (url: string, token?: string, params: Record<string, string> = {}, body?: string) =>
  Object.assign(new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body }),
  }), { params }) as Request & { params: Record<string, string> }

try {
  assert.equal((await upload(request('http://local/api/upload?name=a.txt&sessionId=s-a', undefined, {}, 'private'))).status, 401)
  assert.equal((await upload(request('http://local/api/upload?name=a.txt&sessionId=s-a', 'token-agent', {}, 'private'))).status, 401)
  assert.equal((await upload(request('http://local/api/upload?name=a.txt&sessionId=s-a', 'token-b', {}, 'private'))).status, 404)
  assert.equal((await upload(request('http://local/api/upload?name=a.txt', 'token-a', {}, 'private'))).status, 404)

  const created = await upload(request('http://local/api/upload?name=private.txt&sessionId=s-a', 'token-a', {}, 'private session file'))
  assert.equal(created.status, 200)
  const file = await created.json() as { url: string; name: string; size: number }
  assert.match(file.url, /^\/api\/uploads\/.+\?sessionId=s-a$/)
  const storedName = new URL(file.url, 'http://local').pathname.split('/').at(-1)!
  const routeRequest = (token: string | undefined, sessionId: string) => {
    return request(`http://local/api/uploads/${storedName}?sessionId=${sessionId}`, token, { name: storedName })
  }
  assert.equal((await download(routeRequest(undefined, 's-a'))).status, 401)
  assert.equal((await download(routeRequest('token-b', 's-a'))).status, 404)
  assert.equal((await download(routeRequest('token-a', 's-b'))).status, 404)
  assert.equal((await download(routeRequest('token-a', 's-a'))).status, 200)
  assert.equal(readFileSync(join(root, storedName), 'utf8'), 'private session file')
  const importRoute = routes.get('/api/uploads/:name/import')!
  const importRequest = (token: string, sessionId: string) =>
    request(`http://local/api/uploads/${storedName}/import?sessionId=${sessionId}`, token, { name: storedName })
  assert.equal((await importRoute(importRequest('token-b', 's-a'))).status, 404)
  assert.equal(documents.length, 0, 'uploading a private attachment does not publish it to the shared KB')
  const importedResults = await Promise.all([
    importRoute(importRequest('token-a', 's-a')),
    importRoute(importRequest('token-a', 's-a')),
  ])
  assert.deepEqual(importedResults.map((response) => response.status), [200, 200])
  assert.equal(documents.length, 1)
  assert.equal(documents[0]?.text, 'private session file')
  const importBodies = await Promise.all(importedResults.map((response) => response.json())) as { alreadyImported?: boolean }[]
  assert.equal(importBodies.filter((body) => body.alreadyImported).length, 1, 'concurrent duplicate import joins the in-flight KB write')
  assert.equal((await importRoute(importRequest('token-a', 's-a'))).status, 200, 're-import is idempotent')
  assert.equal(documents.length, 1)
  assert.equal(timeline.length, 1, 'a successful import records one shared-visibility event')
  console.log('✓ Session-bound attachments require explicit, auditable, idempotent team-wide KB import')
} finally {
  rmSync(root, { recursive: true, force: true })
}
