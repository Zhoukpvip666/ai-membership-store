import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, afterEach, beforeEach, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import {
  newToken,
  SESSION_MS,
  sessionCookie,
  tokenHash,
  verifyPassword,
  COOKIE_NAME,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const password = 'IsolatedRegistrationFixture7429!'
const emailAddress = () => randomUUID() + '@example.test'
const registration = '/auth/register'
let origin: string
let server: Server | undefined

beforeEach(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = 'http://127.0.0.1:' + address.port + '/api/v1'
})
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
})
after(() => db.$disconnect())

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  headers?: Record<string, string>,
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MembershipStore',
      Origin: env.APP_BASE_URL,
      Cookie: cookie,
      'Idempotency-Key': randomUUID(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = response.headers.get('set-cookie')
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    cookie: setCookie?.split(';')[0] ?? '',
    setCookie,
    retryAfter: response.headers.get('retry-after'),
  }
}

const register = (email = emailAddress(), cookie = '') =>
  request(registration, 'POST', { email, password }, cookie)

function sql(statement: string) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      process.env.FOUNDATION_DB_TEST + '-mysql-1',
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --database=foundation_test',
    ],
    { input: statement, stdio: 'pipe', timeout: 10000 },
  )
}

async function adminLogin() {
  const result = await request('/auth/login', 'POST', {
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.user.role, 'ADMIN')
  return result
}

test('registration returns only the ACTIVE customer DTO and persists a hashed session', async () => {
  assert.equal((await request('/auth/me')).status, 401)
  const email = emailAddress()
  const registered = await register(' ' + email.toUpperCase() + ' ')
  assert.equal(registered.status, 201)
  assert.deepEqual(Object.keys(registered.body), ['user'])
  const user = registered.body.user
  assert.deepEqual(Object.keys(user).sort(), [
    'activatedAt',
    'createdAt',
    'id',
    'loginEmail',
    'notificationEmail',
    'role',
    'status',
    'updatedAt',
    'username',
  ])
  assert.equal(user.loginEmail, email)
  assert.equal(user.role, 'CUSTOMER')
  assert.equal(user.status, 'ACTIVE')
  assert.ok(user.activatedAt)
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(stored.createdByAdminId, null)
  assert.equal(stored.activatedAt?.toISOString(), user.activatedAt)
  assert.ok(stored.passwordHash?.startsWith('$argon2id$'))
  assert.ok(await verifyPassword(stored.passwordHash!, password))

  const cookie = registered.setCookie!
  assert.ok(/; HttpOnly/i.test(cookie) && /; SameSite=Strict/i.test(cookie))
  assert.ok(/; Path=\//i.test(cookie) && /; Max-Age=43200/i.test(cookie))
  assert.equal(
    /; Secure/i.test(cookie),
    new URL(env.APP_BASE_URL).protocol === 'https:',
  )
  const token = sessionCookie(registered.cookie)
  assert.ok(token)
  const session = await db.session.findUniqueOrThrow({
    where: { tokenHash: tokenHash(token) },
  })
  assert.equal(session.userId, user.id)
  assert.ok(session.tokenHash !== token)
  assert.ok(session.lastSeenAt)
  assert.equal(
    session.expiresAt.getTime() - session.lastSeenAt.getTime(),
    SESSION_MS,
  )
  assert.ok(!JSON.stringify(registered.body).includes(token))
  assert.deepEqual(
    (await request('/auth/me', 'GET', undefined, registered.cookie)).body.user,
    user,
  )

  assert.equal(
    (await request('/auth/logout', 'POST', {}, registered.cookie)).status,
    204,
  )
  assert.equal(
    (await request('/auth/me', 'GET', undefined, registered.cookie)).status,
    401,
  )
  assert.ok(
    (await db.session.findUniqueOrThrow({ where: { id: session.id } }))
      .revokedAt,
  )
})

test('registered customers can order immediately, read their entitlements, and appear in admin search', async () => {
  const registered = await register()
  assert.equal(registered.status, 201)
  const { id, loginEmail } = registered.body.user
  const admin = await adminLogin()
  const listing = await request(
    '/admin/users?search=' + encodeURIComponent(loginEmail),
    'GET',
    undefined,
    admin.cookie,
  )
  assert.equal(listing.status, 200)
  assert.deepEqual(
    listing.body.items.map((item: { id: string }) => item.id),
    [id],
  )
  assert.equal(
    (await request('/admin/users', 'GET', undefined, registered.cookie)).status,
    403,
  )

  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Registration test product',
      type: 'SUBSCRIPTION',
      priceFen: 0,
      renewalPriceFen: 100,
      termLabel: 'Monthly',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      listed: true,
    },
  })
  const orderInput = {
    productId: product.id,
    expectedProductUpdatedAt: product.updatedAt.toISOString(),
    formData: {},
  }
  const placed = await request(
    '/customer/orders',
    'POST',
    orderInput,
    registered.cookie,
  )
  assert.equal(placed.status, 201)
  const orderId = placed.body.order.id
  const stored = await db.order.findUniqueOrThrow({ where: { id: orderId } })
  assert.equal(stored.userId, id)
  assert.equal(stored.createdByUserId, id)
  assert.equal(stored.source, 'USER')

  const fulfilled = await request(
    '/admin/orders/' + orderId + '/fulfill',
    'POST',
    { expectedVersion: 1 },
    admin.cookie,
  )
  assert.equal(fulfilled.status, 200)
  const subscriptionId = fulfilled.body.subscription.id
  for (const path of [
    '/customer/orders/' + orderId,
    '/customer/subscriptions/' + subscriptionId,
  ]) {
    assert.equal(
      (await request(path, 'GET', undefined, registered.cookie)).status,
      200,
    )
    assert.equal(
      (await request(path, 'GET', undefined, admin.cookie)).status,
      404,
    )
  }
})

test('normalized duplicates and simultaneous registration preserve a single account and session', async () => {
  const email = emailAddress()
  const responses = await Promise.all([
    register(email),
    register(' ' + email.toUpperCase() + ' '),
  ])
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  )
  const duplicate = responses.find((response) => response.status === 409)!
  assert.equal(duplicate.body.error.code, 'EMAIL_EXISTS')
  assert.equal(duplicate.setCookie, null)
  const user = await db.user.findUniqueOrThrow({ where: { loginEmail: email } })
  assert.equal(await db.user.count({ where: { loginEmail: email } }), 1)
  assert.equal(await db.session.count({ where: { userId: user.id } }), 1)
  const later = await register(email)
  assert.equal(later.status, 409)
  assert.equal(later.body.error.code, 'EMAIL_EXISTS')
  const login = await request('/auth/login', 'POST', { email, password })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, user.id)
})

test('the ADMIN email and a pending invitation cannot be claimed by registration', async () => {
  const admin = await adminLogin()
  const owner = await db.user.findUniqueOrThrow({
    where: { id: admin.body.user.id },
  })
  const email = emailAddress()
  const pending = await request(
    '/admin/users',
    'POST',
    { loginEmail: email },
    admin.cookie,
  )
  assert.equal(pending.status, 201)
  const pendingId = pending.body.user.id
  const invitation = await request(
    '/admin/users/' + pendingId + '/invitations',
    'POST',
    {},
    admin.cookie,
  )
  assert.equal(invitation.status, 201)
  for (const knownEmail of [owner.loginEmail.toUpperCase(), email]) {
    const duplicate = await register(knownEmail)
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'EMAIL_EXISTS')
    assert.equal(duplicate.setCookie, null)
  }
  const unchangedOwner = await db.user.findUniqueOrThrow({
    where: { id: owner.id },
  })
  assert.equal(unchangedOwner.role, 'ADMIN')
  assert.ok(unchangedOwner.passwordHash === owner.passwordHash)
  const unchangedPending = await db.user.findUniqueOrThrow({
    where: { id: pendingId },
  })
  assert.equal(unchangedPending.status, 'PENDING_ACTIVATION')
  assert.equal(unchangedPending.passwordHash, null)
  assert.equal(unchangedPending.activatedAt, null)
  assert.equal(unchangedPending.createdByAdminId, owner.id)
  const token = new URL(invitation.body.url).hash.slice(1)
  assert.equal(
    (await request('/auth/activate', 'POST', { token, password })).status,
    200,
  )
  const login = await request('/auth/login', 'POST', { email, password })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, pendingId)
})

test('registration rejects managed fields, including role and status, and writes nothing', async () => {
  const email = emailAddress()
  for (const forbidden of [
    { role: 'ADMIN' },
    { status: 'DISABLED' },
    { activatedAt: new Date().toISOString() },
    { createdByAdminId: randomUUID() },
    { confirmation: password },
  ]) {
    const result = await request(registration, 'POST', {
      email,
      password,
      ...forbidden,
    })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'INVALID_INPUT')
    assert.equal(result.setCookie, null)
  }
  assert.equal(await db.user.count({ where: { loginEmail: email } }), 0)
})

test('registration uses the existing email and password validators', async () => {
  const email = emailAddress()
  for (const input of [
    { email: 'not-an-email', password },
    { email, password: 'a'.repeat(11) },
    { email, password: 'a'.repeat(129) },
    { email, password: 'replace_with_example' },
    { email },
  ]) {
    const result = await request(registration, 'POST', input)
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'INVALID_INPUT')
  }
  assert.equal(await db.user.count({ where: { loginEmail: email } }), 0)
})

test('CSRF rejects cross-origin and incomplete headers before registration', async () => {
  const email = emailAddress()
  const invalidHeaders: Record<string, string>[] = [
    { Origin: 'http://example.invalid' },
    { 'X-Requested-With': '' },
    { 'Content-Type': 'text/plain' },
  ]
  for (const headers of invalidHeaders) {
    const result = await request(
      registration,
      'POST',
      { email, password },
      '',
      headers,
    )
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'CSRF_REJECTED')
    assert.equal(result.setCookie, null)
  }
  assert.equal(await db.user.count({ where: { loginEmail: email } }), 0)
})

test('the fifth-attempt budget is independent of login and ignores untrusted forwarded IPs', async () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = await request(registration, 'POST', {}, '', {
      'X-Forwarded-For': '192.0.2.' + attempt,
    })
    assert.equal(result.status, attempt === 6 ? 429 : 400)
    if (attempt === 6) {
      assert.equal(result.body.error.code, 'RATE_LIMITED')
      assert.ok(
        Number(result.retryAfter) > 0 && Number(result.retryAfter) <= 900,
      )
    }
  }
  await adminLogin()
})

test('live admin and customer sessions block identity switches while expired sessions allow signup', async () => {
  const admin = await adminLogin()
  const existing = await register()
  assert.equal(existing.status, 201)
  const email = emailAddress()
  for (const account of [admin, existing]) {
    const denied = await register(email, account.cookie)
    assert.equal(denied.status, 409)
    assert.equal(denied.body.error.code, 'ALREADY_AUTHENTICATED')
    assert.equal(denied.setCookie, null)
    assert.equal(
      (await request('/auth/me', 'GET', undefined, account.cookie)).body.user
        .id,
      account.body.user.id,
    )
  }
  assert.equal(await db.user.count({ where: { loginEmail: email } }), 0)
  const token = newToken()
  await db.session.create({
    data: {
      userId: existing.body.user.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() - 1000),
    },
  })
  const expired = COOKIE_NAME + '=' + token
  assert.equal(
    (await request('/auth/me', 'GET', undefined, expired)).status,
    401,
  )
  const registered = await register(email, expired)
  assert.equal(registered.status, 201)
  assert.notEqual(registered.body.user.id, existing.body.user.id)
})

test('a database failure while creating the session rolls back the new user and sends a safe error', async () => {
  const email = emailAddress()
  const sessions = await db.session.count()
  sql(
    "CREATE TRIGGER Registration_test_failure BEFORE INSERT ON Session FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_REGISTRATION_FAILURE';",
  )
  try {
    const result = await register(email)
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'UNAVAILABLE')
    assert.ok(
      !JSON.stringify(result.body).includes('ISOLATED_REGISTRATION_FAILURE'),
    )
    assert.equal(result.setCookie, null)
    assert.equal(await db.user.count({ where: { loginEmail: email } }), 0)
    assert.equal(await db.session.count(), sessions)
  } finally {
    sql('DROP TRIGGER IF EXISTS Registration_test_failure;')
  }
  assert.equal((await register(email)).status, 201)
})
