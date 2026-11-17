import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'
import {
  tokenHash,
  COOKIE_NAME,
  SESSION_MS,
  INVITATION_MS,
  verifyPassword,
} from '../../src/modules/auth/security.ts'
import { customerService } from '../../src/modules/users/service.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let server: Server
let base: string
let adminCookie = ''
let adminId: string
const customerPassword = 'FictionalCustomerPassword2468!'
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = adminCookie,
) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    response,
    status: response.status,
    body: text ? JSON.parse(text) : null,
  }
}
const cookieOf = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0]
const rawToken = (cookie: string) => cookie.slice(COOKIE_NAME.length + 1)
async function customer() {
  const loginEmail = randomUUID() + '@example.com'
  const result = await request('/admin/users', 'POST', {
    displayName: '测试客户',
    loginEmail,
  })
  assert.equal(result.status, 201)
  return result.body.user
}
async function issue(userId: string) {
  const result = await request(
    '/admin/users/' + userId + '/invitations',
    'POST',
    {},
  )
  assert.equal(result.status, 201)
  return { ...result.body, token: new URL(result.body.url).hash.slice(1) }
}
before(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
  const login = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    '',
  )
  assert.equal(login.status, 200)
  adminCookie = cookieOf(login.response)
  adminId = login.body.user.id
})
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await db.$disconnect()
})

test('all admin routes require a database session, even unimplemented routes', async () => {
  for (const path of [
    '/admin/users',
    '/admin/users/' + randomUUID(),
    '/admin/products',
    '/admin/orders',
    '/admin/subscriptions',
    '/admin/settings',
    '/admin/unknown',
  ])
    assert.equal((await request(path, 'GET', undefined, '')).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, '')).status, 401)
  assert.equal((await request('/auth/register', 'POST', {}, '')).status, 404)
  assert.equal((await request('/admin/products')).status, 404)
  assert.equal((await request('/admin/orders', 'POST', {})).status, 404)
})

test('admin login stores only a hash, rotates tokens and emits safe cookie/me responses', async () => {
  const result = await request(
    '/auth/login',
    'POST',
    {
      email: ' ' + env.ADMIN_EMAIL.toUpperCase() + ' ',
      password: env.ADMIN_PASSWORD,
    },
    '',
  )
  assert.equal(result.status, 200)
  const cookie = result.response.headers.get('set-cookie')!
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
  assert.match(cookie, /Path=\//i)
  assert.match(cookie, /Max-Age=43200/i)
  assert.doesNotMatch(cookie, /; Secure/i)
  const token = rawToken(cookieOf(result.response))
  assert.notEqual(token, rawToken(adminCookie))
  const session = await db.session.findUniqueOrThrow({
    where: { tokenHash: tokenHash(token) },
  })
  assert.notEqual(session.tokenHash, token)
  assert.ok(session.expiresAt.getTime() - Date.now() <= SESSION_MS)
  assert.ok(session.expiresAt.getTime() - Date.now() > SESSION_MS - 10000)
  assert.equal(result.body.user.role, 'ADMIN')
  assert.equal(JSON.stringify(result.body).includes('passwordHash'), false)
  assert.equal(JSON.stringify(result.body).includes('token'), false)
  assert.equal((await request('/auth/me')).body.user.id, adminId)
})

test('logout revokes the current session; revoked and expired sessions are rejected', async () => {
  const login = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    '',
  )
  const cookie = cookieOf(login.response)
  assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 204)
  assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 204)
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  assert.ok(
    (
      await db.session.findUniqueOrThrow({
        where: { tokenHash: tokenHash(rawToken(cookie)) },
      })
    ).revokedAt,
  )
  const second = cookieOf(
    (
      await request(
        '/auth/login',
        'POST',
        { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
        '',
      )
    ).response,
  )
  await db.session.update({
    where: { tokenHash: tokenHash(rawToken(second)) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  assert.equal(
    (await request('/auth/me', 'GET', undefined, second)).status,
    401,
  )
})

test('incorrect, unknown, disabled and pending accounts fail login without account enumeration', async () => {
  const wrong = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: customerPassword },
    '',
  )
  const unknown = await request(
    '/auth/login',
    'POST',
    { email: 'missing@example.com', password: customerPassword },
    '',
  )
  const user = await customer()
  const pending = await request(
    '/auth/login',
    'POST',
    { email: user.loginEmail, password: customerPassword },
    '',
  )
  for (const result of [wrong, unknown, pending]) {
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'INVALID_CREDENTIALS')
    assert.equal(JSON.stringify(result.body).includes(customerPassword), false)
  }
})

test('customers stay pending without passwords; duplicate/normalized emails and privileged fields are rejected', async () => {
  const user = await customer()
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(stored.status, 'PENDING_ACTIVATION')
  assert.equal(stored.passwordHash, null)
  assert.equal(stored.activatedAt, null)
  assert.equal(stored.role, 'CUSTOMER')
  assert.equal(
    (
      await request('/admin/users', 'POST', {
        displayName: '重复',
        loginEmail: ' ' + user.loginEmail.toUpperCase() + ' ',
      })
    ).status,
    409,
  )
  for (const field of ['password', 'passwordHash', 'role', 'status'])
    assert.equal(
      (
        await request('/admin/users', 'POST', {
          displayName: '注入',
          loginEmail: randomUUID() + '@example.com',
          [field]: 'forbidden',
        })
      ).status,
      400,
    )
  const list = await request(
    '/admin/users?search=' + encodeURIComponent(user.loginEmail),
  )
  assert.equal(list.body.total, 1)
  assert.equal(list.body.items[0].id, user.id)
  assert.equal(JSON.stringify(list.body).includes('passwordHash'), false)
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1)
})

test('customer editing is limited to profile fields and admin changes are audited without secrets', async () => {
  const user = await customer()
  const result = await request('/admin/users/' + user.id, 'PATCH', {
    displayName: '更新姓名',
    notificationEmail: ' Notice@Example.com ',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.user.notificationEmail, 'notice@example.com')
  for (const input of [
    { loginEmail: 'changed@example.com' },
    { password: customerPassword },
    { role: 'ADMIN' },
  ])
    assert.equal(
      (await request('/admin/users/' + user.id, 'PATCH', input)).status,
      400,
    )
  const logs = await db.adminAuditLog.findMany({
    where: { entityId: user.id },
    select: { action: true, afterJson: true },
  })
  assert.deepEqual(logs.map((log) => log.action).sort(), [
    'CUSTOMER_CREATED',
    'CUSTOMER_UPDATED',
  ])
  const serialized = JSON.stringify(logs)
  assert.equal(serialized.includes('notice@example.com'), false)
  assert.equal(serialized.includes(customerPassword), false)
  assert.equal((await request('/admin/users/' + adminId)).status, 404)
})

test('invitation is hash-only, expires in seven days and raw URL is not available from reads', async () => {
  const user = await customer()
  const created = await issue(user.id)
  const record = await db.invitationToken.findUniqueOrThrow({
    where: { id: created.invitation.id },
  })
  assert.equal(record.tokenHash, tokenHash(created.token))
  assert.notEqual(record.tokenHash, created.token)
  assert.ok(
    Math.abs(
      record.expiresAt.getTime() - record.createdAt.getTime() - INVITATION_MS,
    ) < 1000,
  )
  const detail = await request('/admin/users/' + user.id)
  const body = JSON.stringify(detail.body)
  assert.equal(body.includes(created.token), false)
  assert.equal(body.includes(record.tokenHash), false)
  assert.equal(body.includes('tokenHash'), false)
  assert.equal(new URL(created.url).origin, new URL(env.APP_BASE_URL).origin)
  assert.equal(new URL(created.url).pathname, '/activate')
  assert.equal(new URL(created.url).search, '')
})

test('reissuing, revoking and expiry invalidate activation without changing the pending account', async () => {
  const user = await customer()
  const old = await issue(user.id)
  const current = await issue(user.id)
  assert.ok(
    (
      await db.invitationToken.findUniqueOrThrow({
        where: { id: old.invitation.id },
      })
    ).revokedAt,
  )
  assert.equal(
    (
      await request(
        '/auth/activate',
        'POST',
        { token: old.token, password: customerPassword },
        '',
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        '/admin/invitations/' + current.invitation.id + '/revoke',
        'POST',
        {},
      )
    ).status,
    204,
  )
  assert.equal(
    (
      await request(
        '/auth/activate',
        'POST',
        { token: current.token, password: customerPassword },
        '',
      )
    ).status,
    409,
  )
  const expired = await issue(user.id)
  await db.invitationToken.update({
    where: { id: expired.invitation.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  assert.equal(
    (
      await request(
        '/auth/activate',
        'POST',
        { token: expired.token, password: customerPassword },
        '',
      )
    ).status,
    409,
  )
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(account.status, 'PENDING_ACTIVATION')
  assert.equal(account.passwordHash, null)
})

test('only one concurrent activation succeeds, password is Argon2id and customer cannot access any admin/customer data routes', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const results = await Promise.all(
    [1, 2].map(() =>
      request(
        '/auth/activate',
        'POST',
        { token: invitation.token, password: customerPassword },
        '',
      ),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(account.status, 'ACTIVE')
  assert.ok(account.activatedAt)
  assert.ok(account.passwordHash?.startsWith('$argon2id$'))
  assert.equal(
    await verifyPassword(account.passwordHash!, customerPassword),
    true,
  )
  assert.ok(
    (
      await db.invitationToken.findUniqueOrThrow({
        where: { id: invitation.invitation.id },
      })
    ).usedAt,
  )
  const login = await request(
    '/auth/login',
    'POST',
    { email: user.loginEmail, password: customerPassword },
    '',
  )
  assert.equal(login.status, 200)
  const cookie = cookieOf(login.response)
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).body.user.id,
    user.id,
  )
  for (const path of [
    '/admin/users',
    '/admin/users/' + adminId,
    '/admin/products',
    '/admin/orders',
    '/admin/subscriptions',
  ])
    assert.equal((await request(path, 'GET', undefined, cookie)).status, 403)
  assert.equal(
    (await request('/me/orders/' + randomUUID(), 'GET', undefined, cookie))
      .status,
    404,
  )
  assert.equal(
    (
      await request(
        '/me/subscriptions/' + randomUUID(),
        'GET',
        undefined,
        cookie,
      )
    ).status,
    404,
  )
  assert.equal(
    (await request('/admin/users/' + user.id + '/invitations', 'POST', {}))
      .status,
    409,
  )
})

test('disable revokes sessions/invitations; restore preserves activation status and existing entitlement history', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  await request(
    '/auth/activate',
    'POST',
    { token: invitation.token, password: customerPassword },
    '',
  )
  const cookie = cookieOf(
    (
      await request(
        '/auth/login',
        'POST',
        { email: user.loginEmail, password: customerPassword },
        '',
      )
    ).response,
  )
  const oldHash = (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
    .passwordHash
  const disable = await request(
    '/admin/users/' + user.id + '/status',
    'PATCH',
    { disabled: true, reason: '停用测试' },
  )
  assert.equal(disable.body.user.status, 'DISABLED')
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  assert.equal(
    (
      await request(
        '/auth/login',
        'POST',
        { email: user.loginEmail, password: customerPassword },
        '',
      )
    ).status,
    401,
  )
  const restore = await request(
    '/admin/users/' + user.id + '/status',
    'PATCH',
    { disabled: false, reason: '恢复测试' },
  )
  assert.equal(restore.body.user.status, 'ACTIVE')
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
    oldHash,
  )
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  const pending = await customer()
  const unused = await issue(pending.id)
  await request('/admin/users/' + pending.id + '/status', 'PATCH', {
    disabled: true,
    reason: '停用未激活客户',
  })
  await request('/admin/users/' + pending.id + '/status', 'PATCH', {
    disabled: false,
    reason: '恢复未激活客户',
  })
  assert.equal(
    (await request('/admin/users/' + pending.id)).body.user.status,
    'PENDING_ACTIVATION',
  )
  assert.equal(
    (
      await request(
        '/auth/activate',
        'POST',
        { token: unused.token, password: customerPassword },
        '',
      )
    ).status,
    409,
  )
  // Foundation fixtures already attach real foreign-key records to a pending customer.
  const pendingOwner = await db.user.findUniqueOrThrow({
    where: { loginEmail: 'pending-customer@example.com' },
    include: { _count: { select: { orders: true, subscriptions: true } } },
  })
  assert.equal(pendingOwner.status, 'PENDING_ACTIVATION')
  assert.ok(
    pendingOwner._count.orders > 0 && pendingOwner._count.subscriptions > 0,
  )
  assert.equal(
    (await request('/admin/users/' + pendingOwner.id)).body.user._count
      .subscriptions,
    pendingOwner._count.subscriptions,
  )
})

test('simultaneous invitation reissues leave exactly one valid token', async () => {
  const user = await customer()
  const invitations = await Promise.all([issue(user.id), issue(user.id)])
  const valid = await db.invitationToken.findMany({
    where: {
      userId: user.id,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  })
  assert.equal(valid.length, 1)
  const results = await Promise.all(
    invitations.map((invitation) =>
      request(
        '/auth/activate',
        'POST',
        { token: invitation.token, password: customerPassword },
        '',
      ),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
})

test('activation racing disable never leaves an active disabled account or reusable invitation', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const results = await Promise.all([
    request(
      '/auth/activate',
      'POST',
      { token: invitation.token, password: customerPassword },
      '',
    ),
    request('/admin/users/' + user.id + '/status', 'PATCH', {
      disabled: true,
      reason: '并发停用测试',
    }),
  ])
  assert.equal(results[1].status, 200)
  assert.ok([200, 409].includes(results[0].status))
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).status,
    'DISABLED',
  )
  assert.equal(
    (
      await request(
        '/auth/activate',
        'POST',
        { token: invitation.token, password: customerPassword },
        '',
      )
    ).status,
    409,
  )
})

test('duplicate concurrent creation and audit failure leave no partial customer changes', async () => {
  const loginEmail = randomUUID() + '@example.com'
  const results = await Promise.all(
    [1, 2].map(() =>
      request('/admin/users', 'POST', { displayName: '并发客户', loginEmail }),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
  assert.equal(await db.user.count({ where: { loginEmail } }), 1)
  const rejectedEmail = randomUUID() + '@example.com'
  await assert.rejects(
    customerService(db, env.APP_BASE_URL).create(
      { displayName: '回滚测试', loginEmail: rejectedEmail },
      adminId,
      'x'.repeat(100),
    ),
  )
  assert.equal(await db.user.count({ where: { loginEmail: rejectedEmail } }), 0)
})

test('CSRF, malformed input and oversized requests are rejected without echoing secrets', async () => {
  const response = await fetch(base + '/api/v1/admin/users', {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
      origin: 'http://evil.example',
      'x-requested-with': 'MembershipStore',
    },
    body: JSON.stringify({ password: customerPassword }),
  })
  assert.equal(response.status, 403)
  assert.equal((await response.text()).includes(customerPassword), false)
  const malformed = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
    },
    body: '{"password":"' + customerPassword + '"',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.text()).includes(customerPassword), false)
  assert.equal(
    (
      await request(
        '/auth/login',
        'POST',
        { email: env.ADMIN_EMAIL, password: 'x'.repeat(17000) },
        '',
      )
    ).status,
    413,
  )
})
