import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'
import { subscriptionService } from '../../src/modules/subscriptions/service.ts'
import { newToken, tokenHash } from '../../src/modules/auth/security.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL),
  service = subscriptionService(db)
let server: Server,
  base: string,
  cookie = '',
  adminId = ''
const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString()
function auditTrigger(sql: string) {
  // CREATE TRIGGER is not supported by MySQL's prepared-statement protocol.
  // Target only the guarded random test container; credentials stay in its environment.
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
    { input: sql, encoding: 'utf8', stdio: 'pipe', timeout: 10000 },
  )
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const r = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      cookie,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json(), headers: r.headers }
}
async function fixture() {
  const user = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      adminLabel: '内部备注-' + randomUUID(),
      username: '公开用户名',
    },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: '原始商品-' + randomUUID(),
      description: '冻结介绍',
      type: 'SUBSCRIPTION',
      priceFen: 1234,
      renewalPriceFen: 999,
      termLabel: '人工确认周期',
      listed: false,
      formSchema: {
        version: 1,
        fields: [
          {
            id: 'contact',
            type: 'email',
            label: '原联系邮箱',
            required: true,
            hint: '',
          },
        ],
      },
    },
  })
  const input = {
    userId: user.id,
    productId: product.id,
    startedAt: days(-1),
    expiresAt: days(20),
    renewalPriceFen: 999,
    formData: { contact: 'non-sensitive@example.com' },
    note: '内部服务备注',
  }
  return { user, product, input }
}
async function create(input: unknown, key?: string) {
  const r = await request(
    '/admin/subscriptions',
    'POST',
    input,
    key ? { 'Idempotency-Key': key } : {},
  )
  assert.equal(r.status, 201)
  return r.body.subscription
}
before(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const a = server.address()
  assert(a && typeof a !== 'string')
  base = 'http://127.0.0.1:' + a.port
  const r = await request('/auth/login', 'POST', {
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  })
  assert.equal(r.status, 200)
  cookie = r.headers.get('set-cookie')!.split(';')[0]!
  adminId = r.body.user.id
})
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
})

test('ADMIN authorization, customer privacy and CSRF protect all subscription endpoints', async () => {
  const { user, input } = await fixture()
  await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } })
  const token = newToken()
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(days(1)),
    },
  })
  const customerCookie = 'membership_session=' + token
  const me = await request('/auth/me', 'GET', undefined, {
    cookie: customerCookie,
  })
  assert.equal(me.status, 200)
  assert.equal(me.body.user.username, '公开用户名')
  assert(!('adminLabel' in me.body.user))
  for (const path of [
    '/admin/subscriptions',
    '/admin/subscriptions/' + randomUUID(),
    '/admin/subscriptions/' + randomUUID() + '/events',
  ]) {
    assert.equal(
      (await request(path, 'GET', undefined, { cookie: '' })).status,
      401,
    )
    assert.equal(
      (await request(path, 'GET', undefined, { cookie: customerCookie }))
        .status,
      403,
    )
  }
  const s = await create(input)
  for (const [method, suffix, body] of [
    ['POST', '', input],
    ['PATCH', '/' + s.id, { version: 1, reason: 'x', note: 'y' }],
    [
      'POST',
      '/' + s.id + '/renew',
      { version: 1, reason: 'x', newExpiresAt: days(30) },
    ],
    ['POST', '/' + s.id + '/terminate', { version: 1, reason: 'x' }],
  ] as const) {
    assert.equal(
      (
        await request('/admin/subscriptions' + suffix, method, body, {
          cookie: customerCookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request('/admin/subscriptions' + suffix, method, body, {
          origin: 'http://evil.example',
        })
      ).status,
      403,
    )
  }
})
test('pending customer and unlisted product create independent frozen entitlements without orders or payments', async () => {
  const f = await fixture(),
    orders = await db.order.count(),
    payments = await db.paymentTransaction.count()
  const first = await create(f.input),
    second = await create(f.input)
  assert.notEqual(first.id, second.id)
  assert.equal(first.sourceType, 'ADMIN')
  assert.equal(first.version, 1)
  assert.equal(first.productNameSnapshot, f.product.name)
  assert.equal(first.priceSnapshotFen, 1234)
  assert.equal(first.productDescriptionSnapshot, '冻结介绍')
  assert.equal(first.termSnapshot, f.product.termLabel)
  assert.equal(await db.order.count(), orders)
  assert.equal(await db.paymentTransaction.count(), payments)
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: f.user.id } })).status,
    'PENDING_ACTIVATION',
  )
  await db.product.update({
    where: { id: f.product.id },
    data: {
      name: 'Changed',
      description: 'Changed',
      priceFen: 4444,
      formSchema: {
        version: 1,
        fields: [
          { id: 'different', type: 'number', label: 'New', required: true },
        ],
      },
    },
  })
  const updated = await request('/admin/subscriptions/' + first.id, 'PATCH', {
    version: 1,
    reason: '维护旧快照',
    formData: { contact: 'changed@example.com' },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.subscription.productNameSnapshot, f.product.name)
  assert.equal(updated.body.subscription.priceSnapshotFen, 1234)
  const invalid = await request('/admin/subscriptions/' + first.id, 'PATCH', {
    version: 2,
    reason: 'new schema must not apply',
    formData: { different: 1 },
  })
  assert.equal(invalid.status, 400)
})
test('disabled users, archived/one-time products, invalid form values and managed fields are rejected', async () => {
  const f = await fixture()
  await db.user.update({
    where: { id: f.user.id },
    data: { status: 'DISABLED' },
  })
  assert.equal(
    (await request('/admin/subscriptions', 'POST', f.input)).status,
    409,
  )
  await db.user.update({
    where: { id: f.user.id },
    data: { status: 'PENDING_ACTIVATION' },
  })
  for (const patch of [
    { archivedAt: new Date() },
    { archivedAt: null, type: 'ONE_TIME' as const, renewalPriceFen: null },
  ]) {
    await db.product.update({ where: { id: f.product.id }, data: patch })
    assert.equal(
      (await request('/admin/subscriptions', 'POST', f.input)).status,
      409,
    )
  }
  await db.product.update({
    where: { id: f.product.id },
    data: { type: 'SUBSCRIPTION', renewalPriceFen: 999 },
  })
  assert.equal(
    (
      await request('/admin/subscriptions', 'POST', {
        ...f.input,
        formData: { contact: 'bad' },
      })
    ).status,
    400,
  )
  for (const field of [
    'sourceType',
    'status',
    'createdByAdminId',
    'productNameSnapshot',
    'priceSnapshotFen',
    'formSchemaSnapshot',
  ])
    assert.equal(
      (
        await request('/admin/subscriptions', 'POST', {
          ...f.input,
          [field]: 'injected',
        })
      ).status,
      400,
    )
})
test('edit, direct renew, termination and classified history are versioned, atomic and sanitized', async () => {
  const f = await fixture(),
    s = await create(f.input)
  const updated = await request('/admin/subscriptions/' + s.id, 'PATCH', {
    version: 1,
    reason: '资料及日期修正',
    expiresAt: days(21),
    renewalPriceFen: 500,
    formData: { contact: 'updated@example.com' },
    note: 'never-copy-note-to-log',
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.subscription.version, 2)
  assert.equal(
    (
      await request('/admin/subscriptions/' + s.id, 'PATCH', {
        version: 1,
        reason: 'stale',
        note: 'must not overwrite',
      })
    ).status,
    409,
  )
  const renewed = await request(
    '/admin/subscriptions/' + s.id + '/renew',
    'POST',
    {
      version: 2,
      newExpiresAt: days(40),
      renewalPriceFen: 600,
      reason: '人工确认到期',
    },
  )
  assert.equal(renewed.status, 200)
  assert.equal(renewed.body.subscription.version, 3)
  const canceled = await request(
    '/admin/subscriptions/' + s.id + '/terminate',
    'POST',
    { version: 3, reason: '人工取消' },
  )
  assert.equal(canceled.status, 200)
  assert.equal(canceled.body.subscription.status, 'TERMINATED')
  assert.equal(canceled.body.subscription.version, 4)
  assert(canceled.body.subscription.terminatedAt)
  assert.equal(canceled.body.subscription.terminationReason, '人工取消')
  for (const path of ['', '/renew', '/terminate'])
    assert.equal(
      (
        await request(
          '/admin/subscriptions/' + s.id + path,
          path ? 'POST' : 'PATCH',
          path === '/renew'
            ? { version: 4, reason: 'no', newExpiresAt: days(50) }
            : path
              ? { version: 4, reason: 'no' }
              : { version: 4, reason: 'no', note: 'x' },
        )
      ).status,
      409,
    )
  const events = await request('/admin/subscriptions/' + s.id + '/events')
  for (const type of [
    'CREATED',
    'UPDATED',
    'EXPIRY_ADJUSTED',
    'PRICE_CHANGED',
    'FORM_DATA_UPDATED',
    'RENEWED',
    'TERMINATED',
  ])
    assert(
      events.body.items.some(
        (e: { eventType: string }) => e.eventType === type,
      ),
      type,
    )
  const logs =
    JSON.stringify(
      await db.adminAuditLog.findMany({ where: { entityId: s.id } }),
    ) + JSON.stringify(events.body)
  assert(!logs.includes('updated@example.com'))
  assert(!logs.includes('never-copy-note-to-log'))
})
test('archived products retain editable subscriptions but cannot create or renew', async () => {
  const f = await fixture(),
    s = await create(f.input)
  await db.product.update({
    where: { id: f.product.id },
    data: { listed: false, archivedAt: new Date() },
  })
  assert.equal(
    (
      await request('/admin/subscriptions/' + s.id, 'PATCH', {
        version: 1,
        reason: '保留服务维护',
        note: 'allowed',
        expiresAt: days(25),
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await request('/admin/subscriptions/' + s.id + '/renew', 'POST', {
        version: 2,
        reason: 'not allowed',
        newExpiresAt: days(30),
      })
    ).status,
    409,
  )
  assert.equal(
    (await request('/admin/subscriptions', 'POST', f.input)).status,
    409,
  )
})
test('durable idempotency replays exact results, rejects reuse and deduplicates concurrent creates/renewals/termination', async () => {
  const f = await fixture(),
    key = randomUUID()
  const batch = await Promise.all([
    create(f.input, key),
    create(f.input, key),
    create(f.input, key),
  ])
  assert.equal(new Set(batch.map((s) => s.id)).size, 1)
  const s = batch[0]
  assert.equal(await db.subscription.count({ where: { userId: f.user.id } }), 1)
  assert.equal(
    (
      await request(
        '/admin/subscriptions',
        'POST',
        { ...f.input, note: 'different' },
        { 'Idempotency-Key': key },
      )
    ).status,
    409,
  )
  for (const [suffix, method, body] of [
    ['', 'PATCH', { version: 1, reason: 'edit', note: 'idem' }],
    ['/renew', 'POST', { version: 2, reason: 'renew', newExpiresAt: days(60) }],
    ['/terminate', 'POST', { version: 3, reason: 'terminate' }],
  ] as const) {
    const headers = { 'Idempotency-Key': randomUUID() }
    const a = await request(
      '/admin/subscriptions/' + s.id + suffix,
      method,
      body,
      headers,
    )
    const b = await request(
      '/admin/subscriptions/' + s.id + suffix,
      method,
      body,
      headers,
    )
    assert.equal(a.status, 200)
    assert.deepEqual(b.body, a.body)
  }
  // A different service instance reuses the database response even after termination.
  const replay = await subscriptionService(db).create(
    {
      ...f.input,
      startedAt: new Date(f.input.startedAt),
      expiresAt: new Date(f.input.expiresAt),
    },
    adminId,
    'restart-replay',
    key,
  )
  assert.equal(replay.subscription.id, s.id)
  assert.equal(replay.subscription.version, 1)
})
test('concurrent updates have one version winner and audit failure rolls back subscription/events/idempotency', async () => {
  const f = await fixture(),
    s = await create(f.input)
  const race = await Promise.all(
    ['A', 'B'].map((note) =>
      request('/admin/subscriptions/' + s.id, 'PATCH', {
        version: 1,
        reason: 'race',
        note,
      }),
    ),
  )
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409])
  const before = await db.subscription.findUniqueOrThrow({
      where: { id: s.id },
    }),
    events = await db.subscriptionEvent.count({
      where: { subscriptionId: s.id },
    })
  const expired = await create({
    ...f.input,
    startedAt: days(-5),
    expiresAt: days(-1),
  })
  auditTrigger(
    "CREATE TRIGGER phase2_audit_failure BEFORE INSERT ON AdminAuditLog FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test-only failure'",
  )
  try {
    const failedKey = randomUUID(),
      keyCount = await db.idempotencyRecord.count(),
      subscriptionCount = await db.subscription.count()
    assert.equal(
      (
        await request('/admin/subscriptions', 'POST', f.input, {
          'Idempotency-Key': failedKey,
        })
      ).status,
      503,
    )
    assert.equal(await db.subscription.count(), subscriptionCount)
    assert.equal(
      (
        await request(
          '/admin/subscriptions/' + s.id,
          'PATCH',
          { version: 2, reason: 'rollback', note: 'rollback' },
          { 'Idempotency-Key': randomUUID() },
        )
      ).status,
      503,
    )
    assert.deepEqual(
      await db.subscription.findUniqueOrThrow({ where: { id: s.id } }),
      before,
    )
    assert.equal(
      await db.subscriptionEvent.count({ where: { subscriptionId: s.id } }),
      events,
    )
    assert.equal(await db.idempotencyRecord.count(), keyCount)
    await assert.rejects(service.autoTerminate())
    assert.equal(
      (await db.subscription.findUniqueOrThrow({ where: { id: expired.id } }))
        .status,
      'ACTIVE',
    )
  } finally {
    auditTrigger('DROP TRIGGER phase2_audit_failure')
  }
})
test('expired subscriptions reject edits/renewals; automatic termination is idempotent, SYSTEM-audited and races safely', async () => {
  const f = await fixture(),
    s = await create({ ...f.input, startedAt: days(-5), expiresAt: days(-1) })
  assert.equal(
    (
      await request('/admin/subscriptions/' + s.id, 'PATCH', {
        version: 1,
        reason: 'expired',
        note: 'x',
      })
    ).status,
    409,
  )
  const renewBody = {
    version: 1,
    reason: 'race at expiry',
    newExpiresAt: days(60),
  }
  const [renewal] = await Promise.all([
    request('/admin/subscriptions/' + s.id + '/renew', 'POST', renewBody),
    service.autoTerminate(),
    service.autoTerminate(),
  ])
  assert.equal(renewal.status, 409)
  await service.autoTerminate()
  const after = await db.subscription.findUniqueOrThrow({ where: { id: s.id } })
  assert.equal(after.status, 'TERMINATED')
  assert.equal(after.version, 2)
  assert.equal(after.terminationReason, '订阅到期')
  assert.equal(
    await db.subscriptionEvent.count({
      where: {
        subscriptionId: s.id,
        eventType: 'AUTO_TERMINATED',
        actorType: 'SYSTEM',
        actorAdminId: null,
      },
    }),
    1,
  )
  assert.equal(
    await db.adminAuditLog.count({
      where: { entityId: s.id, actorType: 'SYSTEM', actorAdminId: null },
    }),
    1,
  )
  // On a future row, renewal wins and a simultaneous sweep cannot terminate it.
  const active = await create(f.input)
  const [futureRenewal] = await Promise.all([
    request('/admin/subscriptions/' + active.id + '/renew', 'POST', {
      ...renewBody,
      newExpiresAt: days(80),
    }),
    service.autoTerminate(),
  ])
  assert.equal(futureRenewal.status, 200)
  assert.equal(
    (await db.subscription.findUniqueOrThrow({ where: { id: active.id } }))
      .status,
    'ACTIVE',
  )
})
test('a subscription and its idempotent create response remain available for database/API restart checks', async () => {
  const f = await fixture()
  await db.product.update({
    where: { id: f.product.id },
    data: { name: 'Phase 2 restart subscription' },
  })
  const subscription = await create(f.input, 'phase2-restart-persistence')
  await db.product.update({
    where: { id: f.product.id },
    data: {
      name: 'Current renamed restart product',
      formSchema: { version: 1, fields: [] },
    },
  })
  assert.equal(subscription.productNameSnapshot, 'Phase 2 restart subscription')
})

test('filters search private/public names, email and frozen product; user/product/status/source/expiry/date/page work', async () => {
  const f = await fixture(),
    s = await create({ ...f.input, expiresAt: days(2) })
  for (const search of [
    f.user.adminLabel!,
    f.user.loginEmail,
    f.product.name,
    '公开用户名',
  ]) {
    const r = await request(
      '/admin/subscriptions?' +
        new URLSearchParams({
          search,
          userId: f.user.id,
          productId: f.product.id,
          status: 'ACTIVE',
          sourceType: 'ADMIN',
          expiry: 'UPCOMING',
          from: days(1),
          to: days(3),
          pageSize: '1',
        }),
    )
    assert.equal(r.status, 200)
    assert.equal(r.body.total, 1)
    assert.equal(r.body.items[0].id, s.id)
  }
  assert.equal(
    (
      await request(
        '/admin/subscriptions?userId=' + f.user.id + '&expiry=EXPIRED',
      )
    ).body.total,
    0,
  )
  assert.equal(
    (
      await request(
        '/admin/subscriptions?userId=' + f.user.id + '&page=2&pageSize=1',
      )
    ).body.items.length,
    0,
  )
})
