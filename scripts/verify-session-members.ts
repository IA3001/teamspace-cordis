// Session member role changes preserve membership metadata and leave a timeline audit event.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { loadMigrations } from '../packages/impl/space-store-sqlite/src/loader.ts'
import { SqliteEventLog } from '../packages/impl/space-store-sqlite/src/eventlog.ts'
import { SqliteSessionStore } from '../packages/impl/space-store-sqlite/src/session.ts'
import { apply as applySessions } from '../packages/client-ui/space-client-ui-sessions/src/index.ts'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
const migrations = fileURLToPath(new URL('../packages/impl/space-store-sqlite/migrations/', import.meta.url))
for (const migration of loadMigrations(migrations)) db.exec(migration.up)

const ctx = new Context() as Context & Record<string, any>
new SqliteSessionStore(ctx, db)
const eventLog = new SqliteEventLog(ctx, db)
const at = new Date().toISOString()
const insertUser = db.prepare(`INSERT INTO users(id, username, password_hash, display_name, kind, created_at, team_role)
  VALUES (?, ?, '!', ?, 'human', ?, 'member')`)
insertUser.run('u_owner', 'owner', 'Owner', at)
insertUser.run('u_member', 'member', 'Member', at)
insertUser.run('u_second_dri', 'second-dri', 'Second DRI', at)
const users = new Map([
  ['u_owner', { id: 'u_owner', username: 'owner', displayName: 'Owner', kind: 'human' }],
  ['u_member', { id: 'u_member', username: 'member', displayName: 'Member', kind: 'human' }],
  ['u_second_dri', { id: 'u_second_dri', username: 'second-dri', displayName: 'Second DRI', kind: 'human' }],
])
Object.assign(ctx, {
  users: {
    async verifyToken(token: string) {
      const id = token === 'owner-session' ? 'u_owner' : token === 'member-session' ? 'u_member' : ''
      if (!id) throw new Error('unauthorized')
      return users.get(id)
    },
    async byId(id: string) { return users.get(id) ?? null },
    async listHumans() { return [...users.values()] },
  },
  agents: { list: () => [] },
  ui: { registerPanel() {} },
  webui: { addEntry(_entry: unknown, exposed: Record<string, (...args: any[]) => any>) { Object.assign(ctx, { rpc: exposed }) } },
})
applySessions(ctx)
const rpc = ctx.rpc as Record<string, (...args: any[]) => Promise<any>>
const session = ctx.session.createSession({ id: 's_members', title: '成员角色验收' })
ctx.session.join({ sessionId: session.id, principalId: 'u_owner', role: '群主', duty: 'Owner' })
const original = ctx.session.join({ sessionId: session.id, principalId: 'u_member', role: '成员', duty: 'Member duty' })
ctx.session.join({ sessionId: session.id, principalId: 'u_second_dri', role: '成员' })

async function main() {
  assert.equal(await rpc.setMemberRole('bad-session', session.id, 'u_member', 'DRI'), null)
  assert.equal((await rpc.setMemberRole('member-session', session.id, 'u_member', 'DRI')).error, 'forbidden',
    'ordinary session members cannot manage other membership roles')
  const promoted = await rpc.setMemberRole('owner-session', session.id, 'u_member', 'DRI')
  assert.equal(promoted.find((member: { principalId: string }) => member.principalId === 'u_member')?.role, 'DRI')
  const after = ctx.session.listMembers(session.id, true).find((member: { principalId: string }) => member.principalId === 'u_member')
  assert.equal(after.joinedAt, original.joinedAt, 'role changes preserve original joinedAt')
  assert.equal(after.duty, original.duty, 'role changes preserve member duty')
  const changeEvent = eventLog.listBySession(session.id).at(-1)!
  assert.equal(changeEvent.authorKind, 'system')
  assert.match(changeEvent.text, /Owner（u_owner）将 Member（u_member）设为本会话 DRI/)

  const count = eventLog.listBySession(session.id).length
  const transferred = await rpc.setMemberRole('owner-session', session.id, 'u_second_dri', 'DRI')
  assert.equal(transferred.find((member: { principalId: string }) => member.principalId === 'u_second_dri')?.role, 'DRI')
  assert.equal(transferred.find((member: { principalId: string }) => member.principalId === 'u_member')?.role, '成员',
    'assigning a new DRI atomically transfers the sole assignment')
  assert.match(eventLog.listBySession(session.id).at(-1)!.text, /将会话 DRI 从 Member（u_member）转交给 Second DRI（u_second_dri）/)
  assert.equal(eventLog.listBySession(session.id).length, count + 1)
  const noOpCount = eventLog.listBySession(session.id).length
  await rpc.setMemberRole('owner-session', session.id, 'u_second_dri', 'DRI')
  assert.equal(eventLog.listBySession(session.id).length, noOpCount, 'a no-op role update is idempotent and does not duplicate audit events')
  assert.equal((await rpc.setMemberRole('owner-session', session.id, 'u_owner', 'DRI')).error, 'forbidden',
    'the session creator keeps the immutable group-owner role and may use the no-DRI fallback')
  assert.equal((await rpc.setMemberRole('owner-session', session.id, 'u_member', '群主')).error, 'invalid_role')
  assert.equal((await rpc.removeMember('owner-session', session.id, 'u_owner')).error, 'forbidden',
    'the session creator cannot be removed')

  const removeDri = await rpc.removeMember('owner-session', session.id, 'u_second_dri')
  assert.equal(removeDri.some((member: { principalId: string }) => member.principalId === 'u_second_dri'), false,
    'removed members disappear from the active roster')
  assert.equal(ctx.session.listMembers(session.id, false).find((member: { principalId: string }) =>
    member.principalId === 'u_second_dri')?.status, 'left')
  assert.equal(ctx.session.listMembers(session.id, true).some((member: { role: string }) => member.role === 'DRI'), false)
  assert.match(eventLog.listBySession(session.id).at(-1)!.text, /现在没有专属 DRI，群主可继续处理 Agent 待决事项/,
    'removing the assigned DRI explicitly leaves the owner fallback and asks for reassignment')

  assert.equal((await rpc.rename('member-session', session.id, '成员不能改名')).error, 'forbidden',
    'only group owners/admins may rename a session')
  assert.equal((await rpc.rename('owner-session', session.id, '   ')).error, 'invalid_input',
    'a blank title is rejected')
  assert.equal((await rpc.rename('owner-session', session.id, '标题'.repeat(61))).error, 'invalid_input',
    'titles are capped at 120 Unicode characters')
  const renamed = await rpc.rename('owner-session', session.id, '  需求评审  ')
  assert.equal(renamed.title, '需求评审', 'titles are trimmed and persisted')
  assert.equal(ctx.session.getSession(session.id).title, '需求评审')
  assert.match(eventLog.listBySession(session.id).at(-1)!.text, /Owner 将会话标题从「成员角色验收」改为「需求评审」/)
  const renameEventCount = eventLog.listBySession(session.id).length
  await rpc.rename('owner-session', session.id, '需求评审')
  assert.equal(eventLog.listBySession(session.id).length, renameEventCount,
    'renaming to the existing normalized title does not create duplicate timeline events')

  await rpc.invite('owner-session', session.id, ['u_second_dri'])
  const inviteCount = eventLog.listBySession(session.id).length
  await rpc.invite('owner-session', session.id, ['u_second_dri'])
  assert.equal(eventLog.listBySession(session.id).length, inviteCount, 'repeating an active invite does not create a false join event')
  assert.equal((await rpc.members('owner-session', session.id)).length, 3)
  assert.deepEqual(new Set(ctx.session.listMembers(session.id, true).map((m: { principalId: string }) => m.principalId)),
    new Set(['u_owner', 'u_member', 'u_second_dri']))
  console.log('✓ Session member role changes, DRI uniqueness, immutable owner, and membership timeline audit verified')
}

try { await main() } finally { db.close() }
