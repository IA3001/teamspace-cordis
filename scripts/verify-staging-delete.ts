import assert from 'node:assert/strict'
import { apply } from '../plugins/staging-commands/index.ts'
import { IdentityError } from 'space-identity'
import { StagingError } from 'space-staging'

const routes = new Map<string, (req: any) => Promise<Response>>()
const users = new Map([
  ['human-a', { id: 'u_a', kind: 'human' }],
  ['human-b', { id: 'u_b', kind: 'human' }],
  ['agent', { id: 'agent.a', kind: 'agent' }],
])
const removed: unknown[][] = []
const ctx = {
  server: {
    post() {}, get(path: string, handler: (req: any) => Promise<Response>) { routes.set(path, handler) },
    delete(path: string, handler: (req: any) => Promise<Response>) { routes.set(path, handler) },
  },
  commands: { register() {}, list: () => [] },
  staging: {
    list: () => [],
    remove(sessionId: string, seq: number, authorId: string) {
      removed.push([sessionId, seq, authorId])
      if (seq === 9) throw new StagingError('not_author', '只能删除自己创建的暂存条目')
    },
  },
  session: {
    getSession: (id: string) => id === 's-a' ? { id } : null,
    listMembers: () => [{ principalId: 'u_a' }, { principalId: 'u_b' }],
  },
  users: {
    async verifyToken(token: string) {
      const user = users.get(token)
      if (!user) throw new IdentityError('unauthorized', 'unauthorized')
      return user
    },
  },
} as never

apply(ctx)
const remove = routes.get('/api/sessions/:id/staging/:seq')!
const request = (token: string | undefined, id: string, seq: string) => ({
  headers: { get: (name: string) => name === 'authorization' && token ? `Bearer ${token}` : null },
  params: { id, seq },
})

assert.equal((await remove(request(undefined, 's-a', '1'))).status, 401)
assert.equal((await remove(request('agent', 's-a', '1'))).status, 401)
assert.equal((await remove(request('human-a', 's-missing', '1'))).status, 404)
assert.equal((await remove(request('human-a', 's-a', 'nope'))).status, 400)
assert.equal((await remove(request('human-b', 's-a', '9'))).status, 403, 'only the draft author may delete it')
assert.equal((await remove(request('human-a', 's-a', '3'))).status, 200)
assert.deepEqual(removed, [['s-a', 9, 'u_b'], ['s-a', 3, 'u_a']])
console.log('✓ Legacy staging deletion requires a session member and enforces author-only removal')
