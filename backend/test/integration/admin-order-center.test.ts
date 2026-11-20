import { before, beforeEach, afterEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import type { Prisma, User } from '../../src/generated/prisma/client.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { createApp } from '../../src/app.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
let admin: User, customer: User, productId: string, server: Server, base: string
const cookies: Record<string, string> = {}
const schema = {
  version: 1,
  fields: [{ id: 'account', type: 'text', label: 'Account', required: true }],
}
const endpoint = (id: string) => '/admin/orders/' + id + '/internal-note'
async function fixture(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return db.order.create({
    data: {
      orderNo: 'CENTER-' + randomUUID().replaceAll('-', ''),
      userId: customer.id,
      productId,
      source: 'ADMIN',
      createdByAdminId: admin.id,
      kind: 'ONE_TIME',
      productTypeSnapshot: 'ONE_TIME',
      productNameSnapshot: 'Frozen center product',
      productDescriptionSnapshot: 'Original description',
      priceSnapshotFen: 1000,
      termSnapshot: 'Display only',
      formSchemaSnapshot: schema,
      formData: { account: 'Safe identifier' },
      amountFen: 1000,
      contactEmailSnapshot: customer.loginEmail,
      internalNote: null,
      ...extra,
    },
  })
}
async function request(
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  cookie = cookies.admin,
  origin = env.APP_BASE_URL,
) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-requested-with': 'MembershipStore',
      'Idempotency-Key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
async function snapshot() {
  return {
    ...(await businessSnapshot(db)),
    OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
  }
}
async function rejected(
  action: () => ReturnType<typeof request>,
  status: number,
  code?: string,
) {
  const before = await snapshot(),
    result = await action()
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert.deepEqual(await snapshot(), before)
}
function sql(statement: string) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      process.env.FOUNDATION_DB_TEST + '-mysql-1',
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -D foundation_test',
    ],
    {
      input: statement.includes(' BEGIN ')
        ? 'DELIMITER $$\n' + statement.replace(/;$/, '') + '$$\nDELIMITER ;\n'
        : statement,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    },
  )
}
before(async () => {
  admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  customer = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      username: 'Center customer',
      status: 'ACTIVE',
      adminLabel: 'PRIVATE_LABEL',
    },
  })
  const disabled = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      role: 'ADMIN',
      status: 'DISABLED',
    },
  })
  for (const [key, user] of [
    ['admin', admin],
    ['customer', customer],
    ['disabled', disabled],
  ] as const) {
    const token = newToken()
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3600000),
      },
    })
    cookies[key] = COOKIE_NAME + '=' + token
  }
  productId = (
    await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Current different catalog',
        type: 'ONE_TIME',
        priceFen: 9000,
        termLabel: 'No inference',
        formSchema: schema,
      },
    })
  ).id
})
beforeEach(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
})
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))
after(() => db.$disconnect())

test('ADMIN guard, CSRF, strict query/body and customer endpoint exclusion have no writes', async () => {
  const o = await fixture()
  for (const [cookie, status] of [
    ['', 401],
    [cookies.customer, 403],
    [cookies.disabled, 401],
  ] as const) {
    await rejected(
      () =>
        request(
          '/admin/orders/' + o.id + '/events',
          undefined,
          randomUUID(),
          cookie,
        ),
      status,
    )
    await rejected(
      () =>
        request(
          endpoint(o.id),
          { expectedVersion: 1, internalNote: 'note' },
          randomUUID(),
          cookie,
        ),
      status,
    )
  }
  await rejected(
    () =>
      request(
        endpoint(o.id),
        { expectedVersion: 1, internalNote: 'note' },
        randomUUID(),
        cookies.admin,
        'https://foreign.invalid',
      ),
    403,
  )
  for (const body of [
    { expectedVersion: 1 },
    { internalNote: 'x' },
    { expectedVersion: 0, internalNote: 'x' },
    { expectedVersion: 1, internalNote: 'x', amountFen: 0 },
    { expectedVersion: 1, internalNote: 'x'.repeat(2001) },
  ])
    await rejected(() => request(endpoint(o.id), body), 400)
  await rejected(
    () =>
      request(endpoint(o.id), { expectedVersion: 1, internalNote: 'x' }, ''),
    400,
  )
  for (const query of [
    'page=0',
    'pageSize=101',
    'page=1&page=2',
    'hidden=true',
    'search=x',
  ])
    await rejected(
      () => request('/admin/orders/' + o.id + '/events?' + query),
      400,
    )
  await rejected(
    () =>
      request(
        '/customer/orders/' + o.id + '/internal-note',
        { expectedVersion: 1, internalNote: 'x' },
        randomUUID(),
        cookies.customer,
      ),
    404,
  )
})
test('snapshot product type filter combines with states/search, strict enums and pagination/counts', async () => {
  const marker = randomUUID()
  for (let i = 0; i < 3; i++)
    await fixture({
      productNameSnapshot: marker,
      kind: 'INITIAL',
      productTypeSnapshot: 'SUBSCRIPTION',
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      source: i === 0 ? 'USER' : 'ADMIN',
      createdByUserId: i === 0 ? customer.id : null,
      createdByAdminId: i === 0 ? null : admin.id,
    })
  await fixture({ productNameSnapshot: marker })
  const query =
    '/admin/orders?search=' +
    marker +
    '&productType=SUBSCRIPTION&kind=INITIAL&paymentStatus=UNPAID&fulfillmentStatus=NOT_STARTED&pageSize=2'
  const a = await request(query),
    b = await request(query + '&page=2')
  assert.equal(a.status, 200)
  assert.equal(a.body.total, 3)
  assert.equal(b.body.total, 3)
  assert.equal(a.body.items.length, 2)
  assert.equal(b.body.items.length, 1)
  assert.equal(
    new Set([...a.body.items, ...b.body.items].map((o: { id: string }) => o.id))
      .size,
    3,
  )
  assert(
    a.body.items.every(
      (o: { productTypeSnapshot: string }) =>
        o.productTypeSnapshot === 'SUBSCRIPTION',
    ),
  )
  for (const suffix of [
    'productType=OTHER',
    'productType=ONE_TIME&productType=SUBSCRIPTION',
    'productType[x]=ONE_TIME',
  ])
    await rejected(() => request('/admin/orders?' + suffix), 400)
  await rejected(
    () =>
      request(
        '/customer/orders?productType=ONE_TIME',
        undefined,
        randomUUID(),
        cookies.customer,
      ),
    400,
  )
})
test('detail linkedSubscription is null before fulfillment/ONE_TIME and exact minimal allowlist after INITIAL', async () => {
  const one = await fixture(),
    initial = await fixture({
      kind: 'INITIAL',
      productTypeSnapshot: 'SUBSCRIPTION',
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
    })
  assert.equal(
    (await request('/admin/orders/' + one.id)).body.order.linkedSubscription,
    null,
  )
  assert.equal(
    (await request('/admin/orders/' + initial.id)).body.order
      .linkedSubscription,
    null,
  )
  const completed = await fixture({
    kind: 'INITIAL',
    productTypeSnapshot: 'SUBSCRIPTION',
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    renewalPriceSnapshotFen: 900,
    amountFen: 0,
    paymentStatus: 'NOT_REQUIRED',
    fulfillmentStatus: 'PROCESSING',
  })
  const response = await fetch(
    base + '/api/v1/admin/orders/' + completed.id + '/fulfill',
    {
      method: 'POST',
      headers: {
        cookie: cookies.admin,
        origin: env.APP_BASE_URL,
        'content-type': 'application/json',
        'x-requested-with': 'MembershipStore',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )
  assert.equal(response.status, 200)
  const subscription = await db.subscription.findUniqueOrThrow({
    where: { sourceOrderId: completed.id },
  })
  assert.equal(subscription.sourceType, 'ORDER')
  const detail = (await request('/admin/orders/' + completed.id)).body.order
  assert.deepEqual(
    Object.keys(detail.linkedSubscription).sort(),
    [
      'id',
      'sourceType',
      'status',
      'version',
      'productNameSnapshot',
      'startedAt',
      'expiresAt',
    ].sort(),
  )
  assert.equal(detail.linkedSubscription.id, subscription.id)
  assert.equal(detail.linkedSubscription.sourceType, 'ORDER')
  assert(!Object.hasOwn(detail.linkedSubscription, 'formData'))
  assert(!Object.hasOwn(detail.linkedSubscription, 'targetIdentifier'))
  const customerDto = (
    await request(
      '/customer/orders/' + completed.id,
      undefined,
      randomUUID(),
      cookies.customer,
    )
  ).body.order
  assert(!('linkedSubscription' in customerDto))
  assert(!('internalNote' in customerDto))
})
test('event timeline enforces exact DTO, safe operation/field mapping and actual ADMIN USER SYSTEM labels', async () => {
  const o = await fixture(),
    now = new Date()
  const cases = [
    ['ORDER_CREATED', 'ORDER_CREATED'],
    ['NOTE', 'ORDER_EDITED'],
    ['CANCELLED', 'ORDER_CANCELLED'],
    ['PAYMENT_RECORDED', 'PAYMENT_RECORDED'],
    ['PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED'],
    ['NOTE', 'PAYMENT_FAILED'],
    ['REFUND_RECORDED', 'REFUND_RECORDED'],
    ['REFUND_CONFIRMED', 'REFUND_CONFIRMED'],
    ['NOTE', 'REFUND_FAILED'],
    ['COMPLETED', 'ORDER_FULFILLED'],
    ['NOTE', 'ORDER_INTERNAL_NOTE_UPDATED'],
  ] as const
  for (const [eventType, operation] of cases)
    await db.orderEvent.create({
      data: {
        orderId: o.id,
        eventType,
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        createdAt: now,
        note: '<b>plain text</b>',
        fromStateJson: {
          operation,
          version: 1,
          internalNote: 'old',
          paymentStatus: 'UNPAID',
          amountFen: 1000,
          secret: 'AUTH_SECRET',
        },
        toStateJson: {
          operation,
          version: 2,
          internalNote: 'new',
          paymentStatus: 'PAID',
          amountFen: 1000,
          passwordHash: 'AUTH_SECRET',
          formData: { x: 'AUTH_SECRET' },
        },
      },
    })
  await db.orderEvent.create({
    data: {
      orderId: o.id,
      eventType: 'NOTE',
      actorType: 'USER',
      actorUserId: customer.id,
      toStateJson: {
        operation: 'UNTRUSTED_SECRET',
        internalNote: 'SECRET_NOTE',
      },
    },
  })
  await db.orderEvent.create({
    data: {
      orderId: o.id,
      eventType: 'FULFILLMENT_CHANGED',
      actorType: 'SYSTEM',
      toStateJson: ['MALFORMED_SECRET'],
    },
  })
  const before = await snapshot(),
    result = await request('/admin/orders/' + o.id + '/events?pageSize=100')
  assert.equal(result.status, 200)
  assert.equal(result.body.total, 13)
  const items = result.body.items
  for (const event of items) {
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'id',
        'eventType',
        'operation',
        'actorType',
        'actorDisplayName',
        'createdAt',
        'note',
        'summary',
      ].sort(),
    )
    if (event.operation !== 'ORDER_INTERNAL_NOTE_UPDATED')
      assert(
        !('internalNoteBefore' in event.summary) &&
          !('internalNoteAfter' in event.summary),
      )
  }
  const note = items.find(
    (e: { operation: string }) => e.operation === 'ORDER_INTERNAL_NOTE_UPDATED',
  )
  assert.deepEqual(note.summary, {
    versionBefore: 1,
    versionAfter: 2,
    internalNoteBefore: 'old',
    internalNoteAfter: 'new',
  })
  assert.equal(
    items.find((e: { actorType: string }) => e.actorType === 'SYSTEM')
      .actorDisplayName,
    '系统',
  )
  assert.equal(
    items.find((e: { actorType: string }) => e.actorType === 'USER')
      .actorDisplayName,
    customer.username,
  )
  const text = JSON.stringify(result.body)
  for (const secret of [
    'AUTH_SECRET',
    'UNTRUSTED_SECRET',
    'MALFORMED_SECRET',
    'SECRET_NOTE',
    'fromStateJson',
    'toStateJson',
    'passwordHash',
    'PRIVATE_LABEL',
  ])
    assert(!text.includes(secret))
  const a = await request('/admin/orders/' + o.id + '/events?pageSize=4'),
    b = await request('/admin/orders/' + o.id + '/events?pageSize=4&page=2')
  assert.equal(a.body.total, 13)
  assert.equal(b.body.total, 13)
  assert.deepEqual(
    [...a.body.items, ...b.body.items].map((e: { id: string }) => e.id),
    items.slice(0, 8).map((e: { id: string }) => e.id),
  )
  assert.deepEqual(await snapshot(), before)
})
test('note atomically appends exact complete Revision/Event/Audit, trims 2000 chars and replays exact original response', async () => {
  const o = await fixture(),
    key = randomUUID(),
    body = { expectedVersion: 1, internalNote: '  ' + 'x'.repeat(2000) + '  ' }
  const result = await request(endpoint(o.id), body, key)
  assert.equal(result.status, 200)
  assert.equal(result.body.order.version, 2)
  assert.equal(result.body.order.internalNote, 'x'.repeat(2000))
  const updated = await db.order.findUniqueOrThrow({ where: { id: o.id } })
  assert.deepEqual(
    {
      ...updated,
      internalNote: o.internalNote,
      version: o.version,
      updatedAt: o.updatedAt,
    },
    o,
  )
  const revision = await db.orderRevision.findFirstOrThrow({
    where: { orderId: o.id },
  })
  assert.equal(revision.version, 2)
  assert.equal(revision.snapshotSchemaVersion, 1)
  assert.equal(revision.actorUserId, admin.id)
  assert.equal(revision.reason, null)
  assert.deepEqual(revision.snapshotJson, buildOrderSnapshot(updated))
  const event = await db.orderEvent.findFirstOrThrow({
      where: { orderId: o.id },
    }),
    audit = await db.adminAuditLog.findFirstOrThrow({
      where: { entityId: o.id, action: 'ORDER_INTERNAL_NOTE_UPDATED' },
    })
  const beforeState = {
      operation: 'ORDER_INTERNAL_NOTE_UPDATED',
      version: 1,
      internalNote: null,
    },
    afterState = { ...beforeState, version: 2, internalNote: 'x'.repeat(2000) }
  assert.deepEqual(event.fromStateJson, beforeState)
  assert.deepEqual(event.toStateJson, afterState)
  assert.equal(event.note, null)
  assert.equal(event.actorAdminId, admin.id)
  assert.deepEqual(audit.beforeJson, beforeState)
  assert.deepEqual(audit.afterJson, afterState)
  assert.equal(audit.reason, null)
  await request(endpoint(o.id), { expectedVersion: 2, internalNote: 'later' })
  const before = await snapshot()
  assert.deepEqual(await request(endpoint(o.id), body, key), result)
  assert.deepEqual(await snapshot(), before)
  await rejected(
    () =>
      request(
        endpoint(o.id),
        { expectedVersion: 1, internalNote: 'different' },
        key,
      ),
    409,
    'IDEMPOTENCY_CONFLICT',
  )
})
test('empty/null normalization, no-op and stale version never manufacture history', async () => {
  const o = await fixture({ internalNote: 'existing' })
  assert.equal(
    (await request(endpoint(o.id), { expectedVersion: 1, internalNote: '  ' }))
      .status,
    200,
  )
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: o.id } })).internalNote,
    null,
  )
  await rejected(
    () => request(endpoint(o.id), { expectedVersion: 2, internalNote: null }),
    400,
    'NO_CHANGES',
  )
  await rejected(
    () => request(endpoint(o.id), { expectedVersion: 2, internalNote: '' }),
    400,
    'NO_CHANGES',
  )
  await rejected(
    () => request(endpoint(o.id), { expectedVersion: 1, internalNote: 'new' }),
    409,
    'VERSION_CONFLICT',
  )
})
test('notes are independent on PAID COMPLETED CANCELLED REFUND_PENDING REFUNDED and zero-price orders', async () => {
  for (const [paymentStatus, fulfillmentStatus] of [
    ['PAID', 'PROCESSING'],
    ['PAID', 'COMPLETED'],
    ['UNPAID', 'CANCELLED'],
    ['REFUND_PENDING', 'CANCELLED'],
    ['REFUNDED', 'CANCELLED'],
    ['NOT_REQUIRED', 'PROCESSING'],
  ] as const) {
    const o = await fixture({
      paymentStatus,
      fulfillmentStatus,
      amountFen: paymentStatus === 'NOT_REQUIRED' ? 0 : 1000,
    })
    const result = await request(endpoint(o.id), {
      expectedVersion: 1,
      internalNote: 'terminal note',
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } })
    assert.deepEqual(
      {
        ...after,
        internalNote: o.internalNote,
        version: o.version,
        updatedAt: o.updatedAt,
      },
      o,
    )
  }
})
test('hidden system renewal cannot be listed, read, viewed as events or annotated', async () => {
  const start = new Date('2026-01-01T00:00:00.000Z'),
    end = new Date('2026-02-01T00:00:00.000Z')
  const sub = await db.subscription.create({
    data: {
      userId: customer.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Hidden',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      termSnapshot: 'unknown',
      renewalPriceFen: 1000,
      startedAt: start,
      expiresAt: end,
    },
  })
  const o = await fixture({
    source: 'SYSTEM_RENEWAL',
    createdByAdminId: null,
    kind: 'RENEWAL',
    hidden: true,
    subscriptionId: sub.id,
    productTypeSnapshot: 'SUBSCRIPTION',
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    paidAt: start,
    paymentConfirmedAt: start,
    fulfilledAt: start,
    renewalForPeriodStartAt: start,
    renewalPeriodStartAt: end,
    renewalPeriodEndAt: new Date('2026-03-01T00:00:00.000Z'),
    billingAnchorSnapshotAt: start,
    billingTimezoneSnapshot: 'UTC',
    billingRevisionSnapshot: 1,
    renewalRequestKeyHash: randomBytes(32).toString('hex'),
    renewalRequestHash: randomBytes(32).toString('hex'),
  })
  for (const suffix of ['', '/events'])
    await rejected(() => request('/admin/orders/' + o.id + suffix), 404)
  await rejected(
    () => request(endpoint(o.id), { expectedVersion: 1, internalNote: 'x' }),
    404,
  )
  assert.equal(
    (await request('/admin/orders?orderNo=' + o.orderNo)).body.total,
    0,
  )
})
test('real concurrent same-key requests replay once; distinct keys with same version have one winner', async () => {
  const o = await fixture(),
    key = randomUUID(),
    body = { expectedVersion: 1, internalNote: 'concurrent' }
  const results = await Promise.all([
    request(endpoint(o.id), body, key),
    request(endpoint(o.id), body, key),
  ])
  assert.equal(results[0].status, 200)
  assert.deepEqual(results[1], results[0])
  assert.equal(await db.orderRevision.count({ where: { orderId: o.id } }), 1)
  const race = await Promise.all(
    ['a', 'b'].map((internalNote) =>
      request(endpoint(o.id), { expectedVersion: 2, internalNote }),
    ),
  )
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409])
  assert.equal(await db.orderRevision.count({ where: { orderId: o.id } }), 2)
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id } }), 2)
  assert.equal(await db.adminAuditLog.count({ where: { entityId: o.id } }), 2)
})
for (const table of [
  'Order',
  'OrderRevision',
  'OrderEvent',
  'AdminAuditLog',
  'IdempotencyRecord',
])
  test(
    'fault injection rolls back all business/history/idempotency writes at ' +
      table,
    async () => {
      const o = await fixture(),
        trigger = 'Center_fault_' + table
      sql(
        'CREATE TRIGGER `' +
          trigger +
          '` BEFORE ' +
          (table === 'Order' ? 'UPDATE' : 'INSERT') +
          ' ON `' +
          table +
          "` FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TEST_CENTER_ROLLBACK'; END;",
      )
      try {
        await rejected(
          () =>
            request(endpoint(o.id), {
              expectedVersion: 1,
              internalNote: 'must rollback',
            }),
          503,
        )
      } finally {
        sql('DROP TRIGGER `' + trigger + '`;')
      }
    },
  )
