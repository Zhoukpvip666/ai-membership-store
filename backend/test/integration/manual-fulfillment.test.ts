import { before, beforeEach, afterEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import type { Server } from 'node:http'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import {
  PrismaClient,
  Prisma,
  type User,
} from '../../src/generated/prisma/client.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { createApp } from '../../src/app.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'
import { fulfilledSubscriptionDto } from '../../src/modules/orders/fulfill.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
let server: Server, base: string, admin: User, customer: User, productId: string
const cookies: Record<string, string> = {}
const path = (id: string) => `/orders/${id}/fulfill`
const schema = {
  version: 1,
  fields: [{ id: 'account', label: 'Account', type: 'text', required: true }],
}
async function start(database = db) {
  server = createApp(() => checkDatabase(database), { database, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
}
async function close() {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
async function now() {
  return (
    await db.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
  )[0]!.now
}
async function fixture(
  initial = true,
  zero = false,
  extra: Partial<Prisma.OrderUncheckedCreateInput> = {},
) {
  const clock = (await now()).getTime()
  const order = await db.order.create({
    data: {
      orderNo: 'FULFILL-' + randomUUID().replaceAll('-', ''),
      userId: customer.id,
      productId,
      source: 'ADMIN',
      kind: initial ? 'INITIAL' : 'ONE_TIME',
      createdByAdminId: admin.id,
      productTypeSnapshot: initial ? 'SUBSCRIPTION' : 'ONE_TIME',
      productNameSnapshot: 'Frozen entitlement',
      productDescriptionSnapshot: 'Frozen description',
      priceSnapshotFen: 9900,
      termSnapshot: 'Display only',
      servicePeriodUnitSnapshot: initial ? 'MONTH' : null,
      servicePeriodCountSnapshot: initial ? 1 : null,
      renewalPriceSnapshotFen: initial ? 8800 : null,
      formSchemaSnapshot: schema,
      formData: { account: 'PRIVATE_CUSTOMER_IDENTIFIER' },
      internalNote: 'PRIVATE_ORDER_NOTE',
      contactEmailSnapshot: 'contact@example.com',
      amountFen: zero ? 0 : 9900,
      paymentStatus: zero ? 'NOT_REQUIRED' : 'PAID',
      fulfillmentStatus: 'PROCESSING',
      createdAt: new Date(clock - 259200000),
      paidAt: zero ? null : new Date(clock - 172800000),
      paymentConfirmedAt: zero ? null : new Date(clock - 172799000),
      ...extra,
    },
  })
  await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(order),
      actorType: order.source === 'USER' ? 'USER' : 'ADMIN',
      actorUserId: order.source === 'USER' ? order.createdByUserId : admin.id,
    },
  })
  if (!zero)
    await db.paymentTransaction.create({
      data: {
        orderId: order.id,
        kind: 'PAYMENT',
        status: 'CONFIRMED',
        channel: 'BANK_TRANSFER',
        amountFen: order.amountFen,
        occurredAt: order.paidAt ?? new Date(clock - 172800000),
        confirmedAt: order.paymentConfirmedAt,
        createdByAdminId: admin.id,
        confirmedByAdminId: admin.id,
        note: 'PRIVATE_PAYMENT_EVIDENCE',
      },
    })
  return order
}
async function request(
  target: string,
  body: unknown = { expectedVersion: 1 },
  key: string | null = randomUUID(),
  cookie = cookies.admin,
  role = 'admin',
  origin = env.APP_BASE_URL,
) {
  const response = await fetch(base + '/api/v1/' + role + target, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-requested-with': 'MembershipStore',
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }
}
async function snapshot() {
  return {
    ...(await businessSnapshot(db)),
    OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
  }
}
async function rejected(
  action: () => ReturnType<typeof request>,
  status = 409,
  code?: string,
) {
  const before = await snapshot(),
    result = await action()
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Rejected request changed business data/history',
  )
  return result
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
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --database=foundation_test',
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
      status: 'PENDING_ACTIVATION',
    },
  })
  const active = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com', status: 'ACTIVE' },
  })
  const disabled = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      role: 'ADMIN',
      status: 'DISABLED',
    },
  })
  for (const [name, user] of [
    ['admin', admin],
    ['customer', active],
    ['disabled', disabled],
  ] as const) {
    const token = newToken()
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 86400000),
      },
    })
    cookies[name] = COOKIE_NAME + '=' + token
  }
  productId = (
    await db.product.create({
      data: {
        name: 'Mutable product',
        slug: randomUUID(),
        type: 'SUBSCRIPTION',
        priceFen: 9900,
        renewalPriceFen: 8800,
        termLabel: 'Not parsed',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        formSchema: schema,
      },
    })
  ).id
})
beforeEach(async () => {
  await db.appSettings.update({
    where: { id: 1 },
    data: { timezone: 'Asia/Shanghai' },
  })
  await start()
})
afterEach(close)
after(() => db.$disconnect())

test('fulfillment enforces ADMIN Session, role and CSRF without side effects', async () => {
  const order = await fixture()
  await rejected(
    () => request(path(order.id), undefined, randomUUID(), ''),
    401,
  )
  await rejected(
    () => request(path(order.id), undefined, randomUUID(), cookies.disabled),
    401,
  )
  await rejected(
    () => request(path(order.id), undefined, randomUUID(), cookies.customer),
    403,
  )
  await rejected(
    () =>
      request(
        path(order.id),
        undefined,
        randomUUID(),
        cookies.admin,
        'admin',
        'http://localhost:9999',
      ),
    403,
  )
  await rejected(
    () =>
      request(
        path(order.id),
        undefined,
        randomUUID(),
        cookies.customer,
        'customer',
      ),
    404,
  )
})
test('strict body/query/id/key rejects forged states and invalid notes', async () => {
  const order = await fixture()
  for (const body of [
    {},
    { expectedVersion: 0 },
    { expectedVersion: 1, fulfillmentNote: 'x'.repeat(501) },
    { expectedVersion: 1, fulfilledAt: '2026-01-01' },
    { expectedVersion: 1, subscriptionId: randomUUID() },
  ])
    await rejected(() => request(path(order.id), body), 400)
  await rejected(
    () => request(path(order.id), { expectedVersion: 1 }, null),
    400,
  )
  await rejected(() => request(path(order.id) + '?timezone=UTC'), 400)
  await rejected(() => request(path(randomUUID())), 404)
})
test('paid ONE_TIME completes after the payment window, preserving receipt and creating only order history/audit', async () => {
  const order = await fixture(false),
    originalPayments = await db.paymentTransaction.findMany({
      where: { orderId: order.id },
    })
  const result = await request(path(order.id), {
    expectedVersion: 1,
    fulfillmentNote: ' Delivered ',
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(Object.keys(result.body), ['order'])
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.deepEqual(saved, {
    ...order,
    fulfillmentStatus: 'COMPLETED',
    fulfilledAt: saved.fulfilledAt,
    updatedAt: saved.updatedAt,
    version: 2,
  })
  assert(saved.fulfilledAt && saved.fulfilledAt >= order.paymentConfirmedAt!)
  assert.equal(result.body.order.remainingSeconds, 0)
  assert.deepEqual(
    await db.paymentTransaction.findMany({ where: { orderId: order.id } }),
    originalPayments,
  )
  assert.equal(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
    0,
  )
  assert.equal(
    await db.subscriptionEvent.count({ where: { orderId: order.id } }),
    0,
  )
  const revision = await db.orderRevision.findUniqueOrThrow({
    where: { orderId_version: { orderId: order.id, version: 2 } },
  })
  assert.deepEqual(revision.snapshotJson, buildOrderSnapshot(saved))
  assert.equal(revision.reason, 'Delivered')
  const audits = await db.adminAuditLog.findMany({
    where: { requestId: result.headers.get('x-request-id') },
  })
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.action, 'ORDER_FULFILLED')
})
test('INITIAL creates exact frozen ORDER entitlement, one event and two sanitized linked audits', async () => {
  const order = await fixture(true)
  await db.product.update({
    where: { id: productId },
    data: {
      name: 'Changed name',
      priceFen: 1,
      renewalPriceFen: 2,
      archivedAt: await now(),
      listed: false,
      formSchema: { version: 1, fields: [] },
    },
  })
  const result = await request(path(order.id), {
    expectedVersion: 1,
    fulfillmentNote: ' Service delivered ',
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const s = await db.subscription.findUniqueOrThrow({
    where: { sourceOrderId: order.id },
  })
  assert.deepEqual(
    Object.keys(result.body.subscription).sort(),
    [
      'id',
      'userId',
      'productId',
      'sourceType',
      'sourceOrderId',
      'productNameSnapshot',
      'productDescriptionSnapshot',
      'productTypeSnapshot',
      'priceSnapshotFen',
      'termSnapshot',
      'servicePeriodUnitSnapshot',
      'servicePeriodCountSnapshot',
      'formSchemaSnapshot',
      'formData',
      'renewalPriceFen',
      'startedAt',
      'expiresAt',
      'billingAnchorAt',
      'billingTimezone',
      'billingRevision',
      'currentPeriodStartAt',
      'currentPeriodEndAt',
      'earlyRenewalUsed',
      'earlyRenewedPeriodStartAt',
      'earlyRenewalOrderId',
      'status',
      'version',
      'createdByAdminId',
      'createdAt',
      'updatedAt',
    ].sort(),
  )
  assert.deepEqual(
    result.body.subscription,
    JSON.parse(JSON.stringify(fulfilledSubscriptionDto(s))),
  )
  assert.deepEqual(Object.keys(result.body).sort(), ['order', 'subscription'])
  for (const field of [
    'productNameSnapshot',
    'productDescriptionSnapshot',
    'productTypeSnapshot',
    'priceSnapshotFen',
    'termSnapshot',
    'servicePeriodUnitSnapshot',
    'servicePeriodCountSnapshot',
    'formSchemaSnapshot',
    'formData',
  ] as const)
    assert.deepEqual(s[field], order[field])
  assert.equal(s.renewalPriceFen, 8800)
  assert.equal(s.userId, order.userId)
  assert.equal(s.productId, order.productId)
  assert.equal(s.sourceType, 'ORDER')
  assert.equal(s.status, 'ACTIVE')
  assert.equal(s.version, 1)
  assert.equal(s.createdByAdminId, admin.id)
  assert.equal(s.targetIdentifier, null)
  assert.equal(s.earlyRenewalUsed, false)
  assert.equal(s.earlyRenewedPeriodStartAt, null)
  assert.equal(s.earlyRenewalOrderId, null)
  assert.equal(s.billingRevision, 1)
  assert.equal(s.billingTimezone, 'Asia/Shanghai')
  for (const time of [
    s.billingAnchorAt,
    s.currentPeriodStartAt,
    new Date(result.body.order.fulfilledAt),
  ])
    assert.deepEqual(time, s.startedAt)
  assert.deepEqual(s.currentPeriodEndAt, s.expiresAt)
  const revision = await db.orderRevision.findUniqueOrThrow({
    where: { orderId_version: { orderId: order.id, version: 2 } },
  })
  assert.deepEqual(
    revision.snapshotJson,
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  )
  const event = await db.orderEvent.findFirstOrThrow({
    where: { orderId: order.id },
  })
  assert.equal(event.eventType, 'COMPLETED')
  assert.equal(event.note, 'Service delivered')
  assert.deepEqual(event.createdAt, s.startedAt)
  assert.deepEqual(event.fromStateJson, {
    operation: 'ORDER_FULFILLED',
    orderId: order.id,
    version: 1,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'PROCESSING',
    fulfilledAt: null,
    subscriptionId: null,
  })
  assert.deepEqual(event.toStateJson, {
    operation: 'ORDER_FULFILLED',
    orderId: order.id,
    version: 2,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    fulfilledAt: s.startedAt.toISOString(),
    subscriptionId: s.id,
  })
  const se = await db.subscriptionEvent.findMany({
    where: { orderId: order.id },
  })
  assert.equal(se.length, 1)
  assert.equal(se[0]!.eventType, 'CREATED')
  assert.equal(se[0]!.beforeJson, null)
  assert.deepEqual(se[0]!.newStartedAt, s.startedAt)
  assert.deepEqual(se[0]!.newExpiresAt, s.expiresAt)
  const audits = await db.adminAuditLog.findMany({
    where: { requestId: result.headers.get('x-request-id') },
    orderBy: { action: 'asc' },
  })
  assert.deepEqual(
    audits.map((a) => a.action),
    ['ORDER_FULFILLED', 'SUBSCRIPTION_CREATED'],
  )
  assert(
    audits.every(
      (a) => a.actorAdminId === admin.id && a.reason === 'Service delivered',
    ),
  )
  assert.deepEqual(audits[0]!.beforeJson, event.fromStateJson)
  assert.deepEqual(audits[0]!.afterJson, event.toStateJson)
  assert.equal(audits[0]!.entityType, 'Order')
  assert.equal(audits[0]!.entityId, order.id)
  assert.equal(audits[1]!.entityType, 'Subscription')
  assert.equal(audits[1]!.entityId, s.id)
  assert.equal(audits[1]!.beforeJson, null)
  assert.deepEqual(audits[1]!.afterJson, se[0]!.afterJson)
  for (const audit of audits) assert.deepEqual(audit.createdAt, s.startedAt)
  const history = JSON.stringify([
    event.fromStateJson,
    event.toStateJson,
    se[0]!.afterJson,
    ...audits.map((a) => a.afterJson),
  ])
  for (const secret of [
    'PRIVATE_CUSTOMER_IDENTIFIER',
    'PRIVATE_ORDER_NOTE',
    'PRIVATE_PAYMENT_EVIDENCE',
    'formData',
  ])
    assert(!history.includes(secret))
  await db.appSettings.update({ where: { id: 1 }, data: { timezone: 'UTC' } })
  assert.deepEqual(
    await db.subscription.findUniqueOrThrow({ where: { id: s.id } }),
    s,
  )
  await rejected(() => request(path(order.id)), 409)
})
test('zero-price INITIAL and ONE_TIME fulfill without fake payment facts', async () => {
  for (const initial of [true, false]) {
    const order = await fixture(initial, true, {
      source: 'USER',
      createdByAdminId: null,
      createdByUserId: customer.id,
    })
    const result = await request(path(order.id), {
      expectedVersion: 1,
      fulfillmentNote: '   ',
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.order.paymentStatus, 'NOT_REQUIRED')
    assert.equal(result.body.order.paidAt, null)
    assert.equal(result.body.order.paymentConfirmedAt, null)
    assert.equal(
      await db.paymentTransaction.count({ where: { orderId: order.id } }),
      0,
    )
    assert.equal(
      await db.subscription.count({ where: { sourceOrderId: order.id } }),
      initial ? 1 : 0,
    )
    assert.equal(
      (await db.orderEvent.findFirstOrThrow({ where: { orderId: order.id } }))
        .note,
      null,
    )
  }
})
test('receipt anomalies, pending attempts and every refund status prevent paid fulfillment', async () => {
  const cases: Partial<Prisma.PaymentTransactionUncheckedUpdateInput>[] = [
    { amountFen: 100 },
    { status: 'FAILED' },
    { status: 'PENDING', confirmedAt: null },
    { confirmedAt: null },
    { occurredAt: new Date('2001-01-01') },
    { confirmedAt: new Date('2002-01-01') },
  ]
  for (const change of cases) {
    const order = await fixture(),
      receipt = await db.paymentTransaction.findFirstOrThrow({
        where: { orderId: order.id },
      })
    await db.paymentTransaction.update({
      where: { id: receipt.id },
      data: change,
    })
    await rejected(() => request(path(order.id)), 409, 'ORDER_NOT_FULFILLABLE')
  }
  for (const kind of ['PAYMENT', 'REFUND'] as const)
    for (const status of ['PENDING', 'CONFIRMED', 'FAILED'] as const) {
      if (kind === 'PAYMENT' && status === 'FAILED') continue
      const order = await fixture()
      await db.paymentTransaction.create({
        data: {
          orderId: order.id,
          kind,
          status,
          channel: 'CASH',
          amountFen: 9900,
          occurredAt: order.paidAt!,
          createdByAdminId: admin.id,
        },
      })
      await rejected(
        () => request(path(order.id)),
        409,
        'ORDER_NOT_FULFILLABLE',
      )
    }
  const order = await fixture()
  await db.paymentTransaction.deleteMany({ where: { orderId: order.id } })
  await rejected(() => request(path(order.id)), 409, 'ORDER_NOT_FULFILLABLE')
})
test('failed unconfirmed payment history is retained and does not block valid paid fulfillment', async () => {
  const order = await fixture()
  const failed = await db.paymentTransaction.create({
    data: {
      orderId: order.id,
      kind: 'PAYMENT',
      status: 'FAILED',
      channel: 'CASH',
      amountFen: 100,
      occurredAt: order.paidAt!,
      createdByAdminId: admin.id,
    },
  })
  assert.equal((await request(path(order.id))).status, 200)
  assert.deepEqual(
    await db.paymentTransaction.findUniqueOrThrow({ where: { id: failed.id } }),
    failed,
  )
})
test('any payment/refund history prevents zero-price fulfillment', async () => {
  for (const kind of ['PAYMENT', 'REFUND'] as const)
    for (const status of ['PENDING', 'CONFIRMED', 'FAILED'] as const) {
      const order = await fixture(true, true)
      await db.paymentTransaction.create({
        data: {
          orderId: order.id,
          kind,
          status,
          channel: 'CASH',
          amountFen: 1,
          occurredAt: await now(),
          createdByAdminId: admin.id,
        },
      })
      await rejected(
        () => request(path(order.id)),
        409,
        'ORDER_NOT_FULFILLABLE',
      )
    }
})
test('unpaid, pending, refunded, cancelled, completed and failed orders cannot fulfill', async () => {
  for (const extra of [
    { paymentStatus: 'UNPAID', paidAt: null, paymentConfirmedAt: null },
    {
      paymentStatus: 'PENDING_VERIFICATION',
      paidAt: null,
      paymentConfirmedAt: null,
    },
    { paymentStatus: 'REFUND_PENDING' },
    { paymentStatus: 'REFUNDED' },
    { fulfillmentStatus: 'NOT_STARTED' },
    { fulfillmentStatus: 'FAILED' },
    {
      fulfillmentStatus: 'CANCELLED',
      cancelledAt: new Date(),
      cancellationReason: 'Cancelled',
    },
    { fulfillmentStatus: 'COMPLETED', fulfilledAt: new Date() },
  ] satisfies Partial<Prisma.OrderUncheckedCreateInput>[]) {
    const order = await fixture(true, false, extra)
    await rejected(() => request(path(order.id)), 409, 'ORDER_NOT_FULFILLABLE')
  }
})
test('invalid frozen renewal price, price, schema or form values are rejected, never repaired from Product', async () => {
  for (const extra of [
    { renewalPriceSnapshotFen: null },
    { priceSnapshotFen: null },
    { formSchemaSnapshot: Prisma.JsonNull },
    { formData: {} },
    { formData: { account: 123 } },
    {
      servicePeriodCountSnapshot: 2147483647,
      servicePeriodUnitSnapshot: 'YEAR',
    },
  ] satisfies Partial<Prisma.OrderUncheckedCreateInput>[]) {
    const order = await fixture(true, false, extra)
    await rejected(() => request(path(order.id)), 409, 'ORDER_NOT_FULFILLABLE')
  }
  // Already enforced database constraints are exercised without relaxing them.
  for (const extra of [
    { kind: 'ONE_TIME', productTypeSnapshot: 'SUBSCRIPTION' },
    { servicePeriodUnitSnapshot: null },
    { servicePeriodCountSnapshot: null },
  ] satisfies Partial<Prisma.OrderUncheckedCreateInput>[])
    await assert.rejects(() => fixture(true, false, extra))
})
test('invalid or missing billing settings roll back; ONE_TIME needs no billing setting', async () => {
  for (const timezone of ['Invalid/Zone', '+08:00']) {
    await db.appSettings.update({ where: { id: 1 }, data: { timezone } })
    const order = await fixture()
    await rejected(() => request(path(order.id)), 503, 'SETTINGS_UNAVAILABLE')
  }
  assert.equal((await request(path((await fixture(false)).id))).status, 200)
  const settings = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  const missingSettingsOrder = await fixture()
  await db.appSettings.delete({ where: { id: 1 } })
  try {
    await rejected(
      () => request(path(missingSettingsOrder.id)),
      503,
      'SETTINGS_UNAVAILABLE',
    )
  } finally {
    await db.appSettings.create({ data: settings })
  }
})
test('an already consumed sourceOrderId is rejected and its unique constraint is effective', async () => {
  const order = await fixture()
  const data = {
    userId: order.userId,
    productId,
    sourceType: 'ADMIN' as const,
    sourceOrderId: order.id,
    productTypeSnapshot: 'SUBSCRIPTION' as const,
    productNameSnapshot: 'Existing',
    priceSnapshotFen: 1,
    termSnapshot: 'Unknown',
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    renewalPriceFen: 1,
  }
  await db.subscription.create({ data })
  await assert.rejects(() => db.subscription.create({ data }))
  await rejected(() => request(path(order.id)), 409, 'ORDER_NOT_FULFILLABLE')
})
test('hidden SYSTEM_RENEWAL orders are not exposed by the fulfillment endpoint', async () => {
  const clock = await now(),
    sub = await db.subscription.create({
      data: {
        userId: customer.id,
        productId,
        sourceType: 'ADMIN',
        productNameSnapshot: 'Legacy',
        productTypeSnapshot: 'SUBSCRIPTION',
        priceSnapshotFen: 1,
        termSnapshot: 'Unknown',
        startedAt: clock,
        expiresAt: new Date(clock.getTime() + 86400000),
        renewalPriceFen: 1,
      },
    })
  const order = await db.order.create({
    data: {
      orderNo: randomUUID(),
      userId: customer.id,
      productId,
      source: 'SYSTEM_RENEWAL',
      kind: 'RENEWAL',
      hidden: true,
      subscriptionId: sub.id,
      productNameSnapshot: 'Renewal',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1,
      amountFen: 1,
      servicePeriodUnitSnapshot: 'DAY',
      servicePeriodCountSnapshot: 1,
      termSnapshot: 'Day',
      contactEmailSnapshot: 'test@example.com',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'COMPLETED',
      paidAt: clock,
      paymentConfirmedAt: clock,
      fulfilledAt: clock,
      renewalForPeriodStartAt: new Date(clock.getTime() - 86400000),
      renewalPeriodStartAt: clock,
      renewalPeriodEndAt: new Date(clock.getTime() + 86400000),
      billingAnchorSnapshotAt: clock,
      billingTimezoneSnapshot: 'Asia/Shanghai',
      billingRevisionSnapshot: 1,
      renewalRequestKeyHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      renewalRequestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    },
  })
  await rejected(() => request(path(order.id)), 404, 'NOT_FOUND')
})
test('fulfillment freezes a canonical IANA alias and keeps existing disabled customers eligible', async () => {
  const disabled = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com', status: 'DISABLED' },
  })
  await db.appSettings.update({
    where: { id: 1 },
    data: { timezone: 'US/Eastern' },
  })
  const order = await fixture(true, true, { userId: disabled.id })
  const result = await request(path(order.id))
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.subscription.billingTimezone, 'America/New_York')
})
test('same key replays original response after completion, settings/product changes and API reconstruction', async () => {
  const order = await fixture(),
    key = randomUUID(),
    input = { expectedVersion: 1, fulfillmentNote: 'Done' }
  const first = await request(path(order.id), input, key)
  assert.equal(first.status, 200)
  await db.appSettings.update({ where: { id: 1 }, data: { timezone: 'UTC' } })
  await db.product.update({
    where: { id: productId },
    data: {
      name: 'Changed again after fulfillment',
      renewalPriceFen: 7,
      servicePeriodCount: 5,
      formSchema: { version: 1, fields: [] },
    },
  })
  await close()
  await start()
  const before = await snapshot(),
    replay = await request(
      path(order.id),
      { ...input, fulfillmentNote: ' Done ' },
      key,
    )
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body, first.body)
  assert(isDeepStrictEqual(await snapshot(), before))
  await rejected(
    () =>
      request(path(order.id), { ...input, fulfillmentNote: 'Different' }, key),
    409,
    'IDEMPOTENCY_CONFLICT',
  )
  const record = await db.idempotencyRecord.findUniqueOrThrow({
    where: {
      actorUserId_keyHash: {
        actorUserId: admin.id,
        keyHash: createHash('sha256').update(key).digest('hex'),
      },
    },
  })
  assert.deepEqual(record.responseJson, first.body)
  assert(!JSON.stringify(record).includes(key))
})
test('real concurrent same-key requests replay exactly and different keys cannot duplicate entitlement', async () => {
  for (const same of [true, false]) {
    const order = await fixture(),
      key = randomUUID()
    const results = await Promise.all([
      request(path(order.id), { expectedVersion: 1 }, key),
      request(
        path(order.id),
        { expectedVersion: 1 },
        same ? key : randomUUID(),
      ),
    ])
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      same ? [200, 200] : [200, 409],
      JSON.stringify(results.map((r) => r.body)),
    )
    if (same) assert.deepEqual(results[0]!.body, results[1]!.body)
    assert.equal(
      await db.subscription.count({ where: { sourceOrderId: order.id } }),
      1,
    )
    assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      2,
    )
    const subscription = await db.subscription.findUniqueOrThrow({
      where: { sourceOrderId: order.id },
    })
    assert.equal(
      await db.subscriptionEvent.count({
        where: { subscriptionId: subscription.id },
      }),
      1,
    )
    for (const entityId of [order.id, subscription.id])
      assert.equal(await db.adminAuditLog.count({ where: { entityId } }), 1)
  }
})
test('concurrent independent fulfillments exceed the pool without nested connection starvation', async () => {
  for (let round = 0; round < 6; round++) {
    const orders = []
    for (let i = 0; i < 8; i++) orders.push(await fixture())
    const results = await Promise.all(orders.map((o) => request(path(o.id))))
    assert.deepEqual(
      results.map((r) => r.status),
      Array(8).fill(200),
      JSON.stringify(
        results
          .filter((result) => result.status !== 200)
          .map((result) => result.body.error),
      ),
    )
  }
})
test('concurrent billing-settings readers do not block fulfillment and its frozen timezone', async () => {
  const order = await fixture()
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM AppSettings WHERE id = 1 FOR SHARE`
    const result = await request(path(order.id))
    assert.equal(result.status, 200, JSON.stringify(result.body.error))
    assert.equal(result.body.subscription.billingTimezone, 'Asia/Shanghai')
  })
})
test('fulfillment and T16 cancellation serialize on the parent and T18 cannot refund completed orders', async () => {
  const order = await fixture()
  const [fulfilled, cancelled] = await Promise.all([
    request(path(order.id)),
    request(`/orders/${order.id}/cancel`, {
      expectedVersion: 1,
      reason: 'Cannot deliver',
    }),
  ])
  assert.deepEqual([fulfilled.status, cancelled.status].sort(), [200, 409])
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(saved.version, 2)
  assert.equal(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
    fulfilled.status === 200 ? 1 : 0,
  )
  if (fulfilled.status === 200)
    await rejected(() =>
      request(`/orders/${order.id}/refunds`, {
        expectedVersion: 2,
        amountFen: 9900,
        channel: 'BANK_TRANSFER',
        occurredAt: new Date().toISOString(),
      }),
    )
  else
    await rejected(
      () => request(path(order.id), { expectedVersion: 2 }),
      409,
      'ORDER_NOT_FULFILLABLE',
    )
})
test('all eight key write-stage SQL failures roll back every business row and allow exact-key retry', async () => {
  for (const [table, event, condition] of [
    ['Subscription', 'INSERT', "NEW.sourceOrderId = '$id'"],
    ['Order', 'UPDATE', "NEW.id = '$id'"],
    ['OrderRevision', 'INSERT', "NEW.orderId = '$id'"],
    ['OrderEvent', 'INSERT', "NEW.orderId = '$id'"],
    ['SubscriptionEvent', 'INSERT', "NEW.orderId = '$id'"],
    [
      'AdminAuditLog',
      'INSERT',
      "NEW.entityId = '$id' AND NEW.action = 'ORDER_FULFILLED'",
    ],
    [
      'AdminAuditLog',
      'INSERT',
      "NEW.action = 'SUBSCRIPTION_CREATED' AND EXISTS (SELECT 1 FROM Subscription WHERE id=NEW.entityId AND sourceOrderId='$id')",
    ],
    ['IdempotencyRecord', 'INSERT', "NEW.keyHash = '$hash'"],
  ]) {
    const order = await fixture(),
      key = randomUUID(),
      hash = createHash('sha256').update(key).digest('hex')
    sql(
      `CREATE TRIGGER Fulfill_test_failure BEFORE ${event} ON \`${table}\` FOR EACH ROW BEGIN IF ${condition!.replaceAll('$id', order.id).replaceAll('$hash', hash)} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INJECTED_FULFILL_FAILURE'; END IF; END;`,
    )
    try {
      const result = await rejected(
        () => request(path(order.id), { expectedVersion: 1 }, key),
        503,
      )
      assert(!JSON.stringify(result.body).includes('INJECTED'))
    } finally {
      sql('DROP TRIGGER Fulfill_test_failure;')
    }
    assert.equal(
      (await request(path(order.id), { expectedVersion: 1 }, key)).status,
      200,
    )
  }
})
test('database clock drives persisted DST, month-end, leap-year and millisecond results through real HTTP', async () => {
  // initSql changes only connections owned by this isolated test client. The API
  // still runs its real SELECT UTC_TIMESTAMP(3); there is no mocked Prisma/clock.
  const cases = [
    [
      'America/New_York',
      '2026-02-08T07:30:00.123Z',
      'MONTH',
      1,
      '2026-03-08T07:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-10-01T05:30:00.123Z',
      'MONTH',
      1,
      '2026-11-01T05:30:00.123Z',
    ],
    [
      'America/New_York',
      '2026-01-31T15:20:30.123Z',
      'MONTH',
      1,
      '2026-02-28T15:20:30.123Z',
    ],
    [
      'America/New_York',
      '2026-01-31T15:20:30.123Z',
      'MONTH',
      2,
      '2026-03-31T14:20:30.123Z',
    ],
    [
      'Asia/Shanghai',
      '2024-02-29T04:05:06.789Z',
      'YEAR',
      1,
      '2025-02-28T04:05:06.789Z',
    ],
    [
      'Asia/Shanghai',
      '2024-02-29T04:05:06.789Z',
      'YEAR',
      4,
      '2028-02-29T04:05:06.789Z',
    ],
    [
      'Australia/Lord_Howe',
      '2026-09-03T15:45:00.123Z',
      'MONTH',
      1,
      '2026-10-03T15:30:00.000Z',
    ],
    [
      'America/New_York',
      '2026-03-07T17:00:00.123Z',
      'DAY',
      1,
      '2026-03-08T17:00:00.123Z',
    ],
  ] as const
  await close()
  try {
    for (const [timezone, clock, unit, count, expected] of cases) {
      await db.appSettings.update({ where: { id: 1 }, data: { timezone } })
      const order = await fixture(true, true, {
        createdAt: new Date('2020-01-01'),
        servicePeriodUnitSnapshot: unit,
        servicePeriodCountSnapshot: count,
      })
      const url = new URL(env.DATABASE_URL)
      const clockDb = new PrismaClient({
        adapter: new PrismaMariaDb({
          host: url.hostname,
          port: Number(url.port),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: 'foundation_test',
          timezone: 'Z',
          connectionLimit: 5,
          initSql: `SET timestamp=${Date.parse(clock) / 1000}`,
        }),
      })
      let started = false
      try {
        assert.equal(
          (
            await clockDb.$queryRaw<
              { now: Date }[]
            >`SELECT UTC_TIMESTAMP(3) AS now`
          )[0]!.now.toISOString(),
          clock,
        )
        await start(clockDb)
        started = true
        const result = await request(path(order.id))
        assert.equal(result.status, 200, JSON.stringify(result.body))
        assert.equal(result.body.order.fulfilledAt, clock)
        assert.equal(result.body.subscription.expiresAt, expected)
        const saved = await db.subscription.findUniqueOrThrow({
          where: { sourceOrderId: order.id },
        })
        assert.equal(saved.expiresAt.toISOString(), expected)
        assert.equal(saved.billingAnchorAt!.toISOString(), clock)
      } finally {
        if (started) await close()
        await clockDb.$disconnect()
      }
    }
  } finally {
    await start()
  }
})
