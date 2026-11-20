import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { Prisma, type User } from '../../src/generated/prisma/client.ts'
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
const cookies: Record<string, string> = {}
let server: Server, base: string, admin: User, customer: User, productId: string
const recordPath = (id: string) => `/orders/${id}/refunds`
const actionPath = (id: string, action = 'confirm') =>
  `/payment-transactions/${id}/${action}-refund`
const evidenceKeys = [
  'id',
  'orderId',
  'kind',
  'channel',
  'amountFen',
  'status',
  'externalReference',
  'occurredAt',
  'confirmedAt',
  'createdByAdminId',
  'confirmedByAdminId',
  'note',
  'createdAt',
  'updatedAt',
].sort()
async function now() {
  return (
    await db.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
  )[0]!.now
}
async function fixture(
  extra: Partial<Prisma.OrderUncheckedCreateInput> = {},
  channel: 'WECHAT' | 'ALIPAY' | 'BANK_TRANSFER' | 'CASH' | 'OTHER' = 'WECHAT',
) {
  const time = (await now()).getTime(),
    paidAt = new Date(time - 172800000),
    confirmedAt = new Date(time - 172799000)
  const order = await db.order.create({
    data: {
      orderNo: 'REFUND-' + randomUUID().replaceAll('-', ''),
      userId: customer.id,
      productId,
      source: 'ADMIN',
      kind: 'ONE_TIME',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Frozen refund product',
      productDescriptionSnapshot: 'Frozen description',
      productTypeSnapshot: 'ONE_TIME',
      priceSnapshotFen: 1000,
      termSnapshot: 'Once',
      formSchemaSnapshot: { version: 1, fields: [] },
      formData: {},
      amountFen: 1000,
      contactEmailSnapshot: 'contact@example.com',
      internalNote: 'PRIVATE_ORDER_NOTE',
      createdAt: new Date(time - 259200000),
      paymentStatus: 'REFUND_PENDING',
      fulfillmentStatus: 'CANCELLED',
      paidAt,
      paymentConfirmedAt: confirmedAt,
      cancelledAt: new Date(time - 86400000),
      cancellationReason: 'Cannot deliver',
      ...extra,
    },
  })
  await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(order),
      actorType: order.source === 'SYSTEM_RENEWAL' ? 'SYSTEM' : order.source!,
      actorUserId:
        order.source === 'USER'
          ? order.createdByUserId
          : order.createdByAdminId,
    },
  })
  await db.paymentTransaction.create({
    data: {
      orderId: order.id,
      kind: 'PAYMENT',
      channel,
      amountFen: 1000,
      status: 'CONFIRMED',
      occurredAt: paidAt,
      confirmedAt,
      createdByAdminId: admin.id,
      confirmedByAdminId: admin.id,
      externalReference: 'PRIVATE_PAYMENT_REFERENCE',
      note: 'PRIVATE_PAYMENT_NOTE',
    },
  })
  return order
}
type Order = Awaited<ReturnType<typeof fixture>>
const input = (order: Order, expectedVersion = order.version) => ({
  expectedVersion,
  amountFen: 1000,
  channel: 'WECHAT',
  occurredAt: (
    order.cancelledAt ??
    order.paidAt ??
    order.createdAt
  ).toISOString(),
  externalReference: 'PRIVATE_REFUND_REFERENCE',
  note: 'PRIVATE_REFUND_NOTE',
})
async function attempt(
  order: Order,
  extra: Partial<Prisma.PaymentTransactionUncheckedCreateInput> = {},
) {
  return db.paymentTransaction.create({
    data: {
      orderId: order.id,
      kind: 'REFUND',
      channel: 'WECHAT',
      amountFen: 1000,
      occurredAt: order.cancelledAt ?? order.paidAt ?? order.createdAt,
      createdByAdminId: admin.id,
      externalReference: 'PRIVATE_REFUND_REFERENCE',
      note: 'PRIVATE_REFUND_NOTE',
      ...extra,
    },
  })
}
async function request(
  path: string,
  data?: unknown,
  key: string | null = randomUUID(),
  cookie = cookies.admin,
  origin = env.APP_BASE_URL,
  role = 'admin',
) {
  const response = await fetch(base + '/api/v1/' + role + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
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
  status: number,
  code?: string,
) {
  const before = await snapshot(),
    result = await action()
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Rejected request changed business rows/history',
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
function gate() {
  let release!: () => void
  const wait = new Promise<void>((r) => {
    release = r
  })
  return { wait, release }
}
before(async () => {
  admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  customer = await db.user.create({
    data: { status: 'ACTIVE', loginEmail: randomUUID() + '@example.com' },
  })
  const secondAdmin = await db.user.create({
    data: {
      role: 'ADMIN',
      status: 'ACTIVE',
      loginEmail: randomUUID() + '@example.com',
    },
  })
  const disabled = await db.user.create({
    data: { status: 'DISABLED', loginEmail: randomUUID() + '@example.com' },
  })
  for (const [name, user] of [
    ['admin', admin],
    ['secondAdmin', secondAdmin],
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
    cookies[name] = COOKIE_NAME + '=' + token
  }
  productId = (
    await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Refund product',
        type: 'ONE_TIME',
        priceFen: 1000,
        termLabel: 'Once',
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
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
after(async () => {
  await db.$disconnect()
})

test('four ADMIN refund routes require persisted active Sessions, correct role and CSRF', async () => {
  const order = await fixture(),
    refund = await attempt(order)
  for (const [path, data] of [
    [recordPath(order.id), undefined],
    [recordPath(order.id), input(order)],
    [actionPath(refund.id), { expectedVersion: 1 }],
    [
      actionPath(refund.id, 'fail'),
      { expectedVersion: 1, reason: 'Bank rejected' },
    ],
  ] as const) {
    await rejected(() => request(path, data, randomUUID(), ''), 401)
    await rejected(
      () => request(path, data, randomUUID(), cookies.customer),
      403,
    )
    await rejected(
      () => request(path, data, randomUUID(), cookies.disabled),
      401,
    )
    if (data)
      await rejected(
        () =>
          request(
            path,
            data,
            randomUUID(),
            cookies.admin,
            'https://untrusted.example',
          ),
        403,
      )
  }
  await rejected(
    () =>
      request(
        recordPath(order.id),
        undefined,
        randomUUID(),
        cookies.admin,
        env.APP_BASE_URL,
        'customer',
      ),
    403,
  )
  await rejected(
    () =>
      request(
        recordPath(order.id),
        undefined,
        randomUUID(),
        cookies.customer,
        env.APP_BASE_URL,
        'customer',
      ),
    404,
  )
})

test('refund HTTP schemas reject malformed evidence, versions, keys and forged input without writes', async () => {
  const order = await fixture()
  for (const patch of [
    { amountFen: 0 },
    { amountFen: -1 },
    { amountFen: 1.5 },
    { amountFen: '1000' },
    { channel: 'CARD' },
    { occurredAt: undefined },
    { occurredAt: '2026-02-30T10:30:00.000Z' },
    { occurredAt: '2026-11-19T10:30:00Z' },
    { occurredAt: '2026-11-19T10:30:00.000+08:00' },
    { externalReference: 'x'.repeat(121) },
    { note: 'x'.repeat(501) },
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: undefined },
    { status: 'CONFIRMED' },
    { actorId: admin.id },
    { kind: 'PAYMENT' },
    { userId: customer.id },
    { confirmedAt: new Date().toISOString() },
  ])
    await rejected(
      () => request(recordPath(order.id), { ...input(order), ...patch }),
      400,
    )
  for (const key of [null, '', 'invalid key', 'x'.repeat(201)])
    await rejected(() => request(recordPath(order.id), input(order), key), 400)
  for (const query of [
    '?userId=other',
    '?kind=PAYMENT',
    '?page=0',
    '?pageSize=101',
  ])
    await rejected(() => request(recordPath(order.id) + query), 400)
  await rejected(
    () => request(recordPath(order.id) + '?userId=other', input(order)),
    400,
  )
  const refund = await attempt(order)
  for (const reason of [undefined, '', '   ', 'x'.repeat(501)])
    await rejected(
      () =>
        request(actionPath(refund.id, 'fail'), { expectedVersion: 1, reason }),
      400,
    )
  await rejected(
    () =>
      request(actionPath(refund.id), { expectedVersion: 1, reason: 'forged' }),
    400,
  )
  await rejected(
    () =>
      request(actionPath(refund.id) + '?orderId=other', { expectedVersion: 1 }),
    400,
  )
})

test('all channels, ordinary sources and product kinds can register and confirm beyond 24h without altering original payment/cancellation', async () => {
  for (const [index, channel] of (
    ['WECHAT', 'ALIPAY', 'BANK_TRANSFER', 'CASH', 'OTHER'] as const
  ).entries()) {
    const order = await fixture(
      index % 2
        ? {
            source: 'USER',
            createdByAdminId: null,
            createdByUserId: customer.id,
            kind: 'INITIAL',
            productTypeSnapshot: 'SUBSCRIPTION',
            servicePeriodUnitSnapshot: 'MONTH',
            servicePeriodCountSnapshot: 1,
          }
        : {},
      channel,
    )
    const original = await db.paymentTransaction.findMany({
      where: { orderId: order.id },
    })
    const subscriptions = await db.subscription.count()
    const registered = await request(recordPath(order.id), {
      ...input(order),
      channel,
      externalReference: ' PRIVATE_REFUND_REFERENCE ',
      note: ' PRIVATE_REFUND_NOTE ',
    })
    assert.equal(registered.status, 201, JSON.stringify(registered.body))
    assert.equal(registered.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(registered.body).sort(), [
      'order',
      'paymentTransaction',
    ])
    assert.deepEqual(
      Object.keys(registered.body.paymentTransaction).sort(),
      evidenceKeys,
    )
    assert.equal(registered.body.order.paymentStatus, 'REFUND_PENDING')
    assert.equal(registered.body.order.version, 2)
    assert.equal(registered.body.paymentTransaction.status, 'PENDING')
    assert.equal(registered.body.paymentTransaction.confirmedAt, null)
    assert.equal(registered.body.paymentTransaction.confirmedByAdminId, null)
    const pending = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: registered.body.paymentTransaction.id },
    })
    const confirmed = await request(actionPath(pending.id), {
      expectedVersion: 2,
    })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.order.paymentStatus, 'REFUNDED')
    assert.equal(confirmed.body.order.fulfillmentStatus, 'CANCELLED')
    assert.equal(confirmed.body.order.version, 3)
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.deepEqual(saved, {
      ...order,
      paymentStatus: 'REFUNDED',
      version: 3,
      updatedAt: saved.updatedAt,
    })
    const completed = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: pending.id },
    })
    assert.deepEqual(completed, {
      ...pending,
      status: 'CONFIRMED',
      confirmedAt: completed.confirmedAt,
      confirmedByAdminId: admin.id,
      updatedAt: completed.updatedAt,
    })
    assert.equal(
      completed.confirmedAt!.toISOString(),
      confirmed.body.paymentTransaction.confirmedAt,
    )
    assert(completed.confirmedAt! >= completed.occurredAt)
    assert.deepEqual(
      await db.paymentTransaction.findMany({
        where: { orderId: order.id, kind: 'PAYMENT' },
      }),
      original,
    )
    assert.equal(await db.subscription.count(), subscriptions)
    await rejected(
      () => request(recordPath(order.id), { ...input(order, 3), channel }),
      409,
    )
    await rejected(
      () => request(actionPath(pending.id), { expectedVersion: 3 }),
      409,
    )
    await rejected(
      () =>
        request(actionPath(pending.id, 'fail'), {
          expectedVersion: 3,
          reason: 'Too late',
        }),
      409,
    )
  }
})

test('GET is read-only, stably paginated, REFUND-only and excludes missing/hidden orders with safe DTOs', async () => {
  const order = await fixture(),
    time = await now(),
    ids = []
  for (let i = 0; i < 23; i++)
    ids.push((await attempt(order, { status: 'FAILED', createdAt: time })).id)
  const older = await attempt(order, {
    status: 'FAILED',
    createdAt: new Date(time.getTime() - 1000),
  })
  const newer = await attempt(order, {
    status: 'FAILED',
    createdAt: new Date(time.getTime() + 1),
  })
  const other = await fixture()
  await attempt(other, { status: 'FAILED' })
  const before = await snapshot(),
    first = await request(recordPath(order.id)),
    second = await request(recordPath(order.id) + '?page=2&pageSize=20')
  assert.deepEqual(Object.keys(first.body).sort(), [
    'items',
    'page',
    'pageSize',
    'total',
  ])
  assert.equal(first.body.total, 25)
  assert.equal(first.body.page, 1)
  assert.equal(first.body.pageSize, 20)
  assert.deepEqual(
    [...first.body.items, ...second.body.items].map(
      (r: { id: string }) => r.id,
    ),
    [newer.id, ...ids.sort(), older.id],
  )
  for (const row of first.body.items) {
    assert.deepEqual(Object.keys(row).sort(), evidenceKeys)
    assert.equal(row.kind, 'REFUND')
    assert.equal(row.orderId, order.id)
  }
  assert.equal(
    (await request(recordPath(order.id) + '?page=3')).body.items.length,
    0,
  )
  assert(isDeepStrictEqual(await snapshot(), before))
  await rejected(() => request(recordPath(randomUUID())), 404, 'NOT_FOUND')
  await rejected(
    () => request(actionPath(randomUUID()), { expectedVersion: 1 }),
    404,
    'NOT_FOUND',
  )
  await rejected(
    () => request(recordPath(order.id), { ...input(order), id: other.id }),
    400,
  )
})

test('ineligible order summaries, timestamps, zero price and fulfilled orders reject every refund write', async () => {
  for (const extra of [
    { paymentStatus: 'UNPAID' },
    {
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PROCESSING',
      cancelledAt: null,
    },
    { paymentStatus: 'REFUNDED' },
    { fulfillmentStatus: 'NOT_STARTED' },
    { fulfillmentStatus: 'COMPLETED', fulfilledAt: new Date() },
    { cancelledAt: null },
    { paidAt: null },
    { paymentConfirmedAt: null },
    {
      amountFen: 0,
      paymentStatus: 'NOT_REQUIRED',
      paidAt: null,
      paymentConfirmedAt: null,
    },
  ] as Partial<Prisma.OrderUncheckedCreateInput>[]) {
    const order = await fixture(extra),
      refund = await attempt(order)
    await rejected(
      () => request(recordPath(order.id), input(order)),
      409,
      'ORDER_NOT_REFUNDABLE',
    )
    await rejected(
      () => request(actionPath(refund.id), { expectedVersion: 1 }),
      409,
      'ORDER_NOT_REFUNDABLE',
    )
    await rejected(
      () =>
        request(actionPath(refund.id, 'fail'), {
          expectedVersion: 1,
          reason: 'Bank rejected',
        }),
      409,
      'ORDER_NOT_REFUNDABLE',
    )
  }
})

test('original payment must be exactly one confirmed full receipt matching both order payment timestamps', async () => {
  for (const patch of [
    { status: 'PENDING', confirmedAt: null },
    { status: 'FAILED' },
    { confirmedAt: null },
    { amountFen: 999 },
    { occurredAt: new Date(0) },
    { confirmedAt: new Date(1) },
  ] as Partial<Prisma.PaymentTransactionUncheckedUpdateInput>[]) {
    const order = await fixture(),
      receipt = await db.paymentTransaction.findFirstOrThrow({
        where: { orderId: order.id },
      })
    await db.paymentTransaction.update({
      where: { id: receipt.id },
      data: patch,
    })
    const refund = await attempt(order)
    for (const [path, body] of [
      [recordPath(order.id), input(order)],
      [actionPath(refund.id), { expectedVersion: 1 }],
      [
        actionPath(refund.id, 'fail'),
        { expectedVersion: 1, reason: 'No receipt' },
      ],
    ] as const)
      await rejected(() => request(path, body), 409, 'ORDER_NOT_REFUNDABLE')
  }
  const order = await fixture(),
    receipt = await db.paymentTransaction.findFirstOrThrow({
      where: { orderId: order.id },
    })
  await db.paymentTransaction.create({
    data: {
      orderId: order.id,
      kind: 'PAYMENT',
      status: 'CONFIRMED',
      amountFen: 1000,
      channel: 'WECHAT',
      occurredAt: receipt.occurredAt,
      confirmedAt: receipt.confirmedAt,
      createdByAdminId: admin.id,
    },
  })
  await rejected(
    () => request(recordPath(order.id), input(order)),
    409,
    'ORDER_NOT_REFUNDABLE',
  )
})

test('amount/channel and actual refund occurrence are revalidated for registration, confirmation and failure', async () => {
  const order = await fixture()
  await rejected(
    () => request(recordPath(order.id), { ...input(order), amountFen: 999 }),
    409,
    'REFUND_AMOUNT_MISMATCH',
  )
  await rejected(
    () => request(recordPath(order.id), { ...input(order), amountFen: 1001 }),
    409,
    'REFUND_AMOUNT_MISMATCH',
  )
  await rejected(
    () => request(recordPath(order.id), { ...input(order), channel: 'ALIPAY' }),
    409,
    'REFUND_CHANNEL_MISMATCH',
  )
  for (const occurredAt of [
    new Date(order.paidAt!.getTime() - 1),
    new Date((await now()).getTime() + 60000),
  ])
    await rejected(
      () =>
        request(recordPath(order.id), {
          ...input(order),
          occurredAt: occurredAt.toISOString(),
        }),
      400,
      'REFUND_TIME_INVALID',
    )
  for (const [patch, code] of [
    [{ amountFen: 999 }, 'REFUND_AMOUNT_MISMATCH'],
    [{ channel: 'ALIPAY' }, 'REFUND_CHANNEL_MISMATCH'],
    [{ occurredAt: new Date(0) }, 'REFUND_TIME_INVALID'],
    [{ occurredAt: new Date(Date.now() + 60000) }, 'REFUND_TIME_INVALID'],
  ] as const) {
    const targetOrder = await fixture(),
      refund = await attempt(targetOrder, patch)
    await rejected(
      () => request(actionPath(refund.id), { expectedVersion: 1 }),
      409,
      code,
    )
    await rejected(
      () =>
        request(actionPath(refund.id, 'fail'), {
          expectedVersion: 1,
          reason: 'Bank rejected',
        }),
      409,
      code,
    )
  }
  // The lower bound is inclusive and does not infer a cancellation-time bound.
  const boundary = await fixture()
  assert.equal(
    (
      await request(recordPath(boundary.id), {
        ...input(boundary),
        occurredAt: boundary.paidAt!.toISOString(),
      })
    ).status,
    201,
  )
})

test('one pending refund blocks registration; terminal/malformed refund facts cannot be confirmed, failed or reactivated', async () => {
  const order = await fixture(),
    refund = await attempt(order)
  await rejected(
    () => request(recordPath(order.id), input(order)),
    409,
    'OTHER_PENDING_REFUNDS',
  )
  const receipt = await db.paymentTransaction.findFirstOrThrow({
    where: { orderId: order.id, kind: 'PAYMENT' },
  })
  for (const action of ['confirm', 'fail'])
    await rejected(
      () =>
        request(actionPath(receipt.id, action), {
          expectedVersion: 1,
          ...(action === 'fail' ? { reason: 'Wrong kind' } : {}),
        }),
      404,
      'NOT_FOUND',
    )
  for (const extra of [
    { status: 'CONFIRMED', confirmedAt: new Date() },
    { status: 'FAILED', confirmedAt: new Date() },
    { status: 'PENDING', confirmedAt: new Date() },
  ] as Partial<Prisma.PaymentTransactionUncheckedCreateInput>[]) {
    const targetOrder = await fixture(),
      target = await attempt(targetOrder, extra)
    await rejected(
      () => request(recordPath(targetOrder.id), input(targetOrder)),
      409,
      'ORDER_NOT_REFUNDABLE',
    )
    await rejected(
      () => request(actionPath(target.id), { expectedVersion: 1 }),
      409,
      'ORDER_NOT_REFUNDABLE',
    )
  }
  const failedOrder = await fixture(),
    failed = await attempt(failedOrder, { status: 'FAILED' })
  await rejected(
    () => request(actionPath(failed.id), { expectedVersion: 1 }),
    409,
    'REFUND_NOT_PENDING',
  )
  await rejected(
    () =>
      request(actionPath(failed.id, 'fail'), {
        expectedVersion: 1,
        reason: 'Again',
      }),
    409,
    'REFUND_NOT_PENDING',
  )
  const duplicateOrder = await fixture(),
    first = await attempt(duplicateOrder)
  await attempt(duplicateOrder)
  await rejected(
    () => request(actionPath(first.id), { expectedVersion: 1 }),
    409,
    'OTHER_PENDING_REFUNDS',
  )
  await rejected(
    () =>
      request(actionPath(first.id, 'fail'), {
        expectedVersion: 1,
        reason: 'No automatic close',
      }),
    409,
    'OTHER_PENDING_REFUNDS',
  )
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: refund.id },
      })
    ).status,
    'PENDING',
  )
})

test('failure preserves all evidence and cancellation facts; retry uses a new attempt and never reactivates old rows', async () => {
  const order = await fixture(),
    refund = await attempt(order),
    originalPayments = await db.paymentTransaction.findMany({
      where: { orderId: order.id, kind: 'PAYMENT' },
    })
  const failed = await request(actionPath(refund.id, 'fail'), {
    expectedVersion: 1,
    reason: ' Bank rejected ',
  })
  assert.equal(failed.status, 200, JSON.stringify(failed.body))
  const saved = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: refund.id },
  })
  assert.deepEqual(saved, {
    ...refund,
    status: 'FAILED',
    updatedAt: saved.updatedAt,
  })
  const orderAfter = await db.order.findUniqueOrThrow({
    where: { id: order.id },
  })
  assert.deepEqual(orderAfter, {
    ...order,
    version: 2,
    updatedAt: orderAfter.updatedAt,
  })
  await rejected(
    () =>
      request(actionPath(refund.id, 'fail'), {
        expectedVersion: 2,
        reason: 'Again',
      }),
    409,
  )
  const second = await request(recordPath(order.id), input(order, 2))
  assert.equal(second.status, 201, JSON.stringify(second.body))
  assert.notEqual(second.body.paymentTransaction.id, refund.id)
  assert.deepEqual(
    await db.paymentTransaction.findUniqueOrThrow({ where: { id: refund.id } }),
    saved,
  )
  assert.equal(
    (
      await request(actionPath(second.body.paymentTransaction.id), {
        expectedVersion: 3,
      })
    ).status,
    200,
  )
  assert.deepEqual(
    await db.paymentTransaction.findMany({
      where: { orderId: order.id, kind: 'PAYMENT' },
    }),
    originalPayments,
  )
})

test('each success has one complete revision/event/audit/response with precise four-state JSON and sanitized metadata', async () => {
  const order = await fixture(),
    keys = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const first = await request(recordPath(order.id), input(order), keys[0]),
    id = first.body.paymentTransaction.id
  const failed = await request(
    actionPath(id, 'fail'),
    { expectedVersion: 2, reason: 'Bank rejected' },
    keys[1],
  )
  const next = await request(recordPath(order.id), input(order, 3), keys[2]),
    nextId = next.body.paymentTransaction.id
  const confirmed = await request(
    actionPath(nextId),
    { expectedVersion: 4 },
    keys[3],
  )
  assert.deepEqual(
    [first.status, failed.status, next.status, confirmed.status],
    [201, 200, 201, 200],
  )
  const revisions = await db.orderRevision.findMany({
    where: { orderId: order.id },
    orderBy: { version: 'asc' },
  })
  assert.deepEqual(
    revisions.map((r) => r.version),
    [1, 2, 3, 4, 5],
  )
  assert.equal(revisions[2]!.reason, 'Bank rejected')
  assert.deepEqual(
    revisions[4]!.snapshotJson,
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  )
  const events = await db.orderEvent.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
  })
  const audits = await db.adminAuditLog.findMany({
    where: { entityId: { in: [id, nextId] } },
    orderBy: { createdAt: 'asc' },
  })
  assert.equal(events.length, 4)
  assert.equal(audits.length, 4)
  for (const [index, operation] of [
    'REFUND_RECORDED',
    'REFUND_FAILED',
    'REFUND_RECORDED',
    'REFUND_CONFIRMED',
  ].entries()) {
    const recording = operation === 'REFUND_RECORDED',
      transactionId = index < 2 ? id : nextId
    const beforeState = {
      operation,
      orderId: order.id,
      transactionId: recording ? null : transactionId,
      version: index + 1,
      paymentStatus: 'REFUND_PENDING',
      fulfillmentStatus: 'CANCELLED',
      amountFen: recording ? null : 1000,
      channel: recording ? null : 'WECHAT',
      transactionStatus: recording ? null : 'PENDING',
    }
    const afterState = {
      ...beforeState,
      transactionId,
      version: index + 2,
      paymentStatus: index === 3 ? 'REFUNDED' : 'REFUND_PENDING',
      amountFen: 1000,
      channel: 'WECHAT',
      transactionStatus: recording
        ? 'PENDING'
        : index === 1
          ? 'FAILED'
          : 'CONFIRMED',
      ...(index === 1 ? { reason: 'Bank rejected' } : {}),
    }
    assert.deepEqual(
      events[index]!.fromStateJson,
      beforeState,
      `${operation} OrderEvent.fromStateJson`,
    )
    assert.deepEqual(
      events[index]!.toStateJson,
      afterState,
      `${operation} OrderEvent.toStateJson`,
    )
    assert.deepEqual(
      audits[index]!.beforeJson,
      beforeState,
      `${operation} AdminAuditLog.beforeJson`,
    )
    assert.deepEqual(
      audits[index]!.afterJson,
      afterState,
      `${operation} AdminAuditLog.afterJson`,
    )
    assert.equal(events[index]!.eventType, index === 1 ? 'NOTE' : operation)
    assert.equal(events[index]!.actorAdminId, admin.id)
    assert.equal(audits[index]!.actorAdminId, admin.id)
    assert.equal(audits[index]!.action, operation)
    assert.equal(revisions[index + 1]!.actorType, 'ADMIN')
    assert.equal(revisions[index + 1]!.actorUserId, admin.id)
  }
  assert.equal(events[1]!.note, 'Bank rejected')
  assert.equal(audits[1]!.reason, 'Bank rejected')
  for (const row of [...events, ...audits])
    for (const secret of [
      'PRIVATE_PAYMENT_REFERENCE',
      'PRIVATE_PAYMENT_NOTE',
      'PRIVATE_REFUND_REFERENCE',
      'PRIVATE_REFUND_NOTE',
      'PRIVATE_ORDER_NOTE',
      'passwordHash',
      'tokenHash',
    ])
      assert(!JSON.stringify(row).includes(secret))
  for (const key of keys)
    assert.equal(
      await db.idempotencyRecord.count({
        where: {
          actorUserId: admin.id,
          keyHash: createHash('sha256').update(key).digest('hex'),
        },
      }),
      1,
    )
})

test('same-key sequential and simultaneous registration/confirmation/failure replay original DTOs after later transitions', async () => {
  for (const operation of ['confirm', 'fail']) {
    const order = await fixture(),
      key = randomUUID(),
      body = input(order)
    const registrations = await Promise.all([
      request(recordPath(order.id), body, key),
      request(recordPath(order.id), body, key),
    ])
    assert.deepEqual(
      registrations.map((r) => r.status),
      [201, 201],
    )
    assert.deepEqual(registrations[0]!.body, registrations[1]!.body)
    const id = registrations[0]!.body.paymentTransaction.id,
      actionKey = randomUUID(),
      actionBody = {
        expectedVersion: 2,
        ...(operation === 'fail' ? { reason: 'Bank rejected' } : {}),
      }
    const actions = await Promise.all([
      request(actionPath(id, operation), actionBody, actionKey),
      request(actionPath(id, operation), actionBody, actionKey),
    ])
    assert.deepEqual(
      actions.map((r) => r.status),
      [200, 200],
    )
    assert.deepEqual(actions[0]!.body, actions[1]!.body)
    const before = await snapshot()
    assert.deepEqual(
      (await request(recordPath(order.id), body, key)).body,
      registrations[0]!.body,
    )
    assert.deepEqual(
      (await request(actionPath(id, operation), actionBody, actionKey)).body,
      actions[0]!.body,
    )
    assert(isDeepStrictEqual(await snapshot(), before))
    assert.equal(
      await db.paymentTransaction.count({
        where: { orderId: order.id, kind: 'REFUND' },
      }),
      1,
    )
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      3,
    )
    const stored = await db.idempotencyRecord.findUniqueOrThrow({
      where: {
        actorUserId_keyHash: {
          actorUserId: admin.id,
          keyHash: createHash('sha256').update(key).digest('hex'),
        },
      },
    })
    assert(!JSON.stringify(stored).includes(key))
    assert.deepEqual(stored.responseJson, registrations[0]!.body)
    await rejected(
      () => request(recordPath(order.id), { ...body, note: 'Different' }, key),
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    const otherOrder = await fixture()
    await rejected(
      () => request(recordPath(otherOrder.id), input(otherOrder), key),
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    await rejected(
      () =>
        request(
          actionPath(id, 'fail'),
          { expectedVersion: 2, reason: 'Other intent' },
          key,
        ),
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    await rejected(
      () => request(recordPath(order.id), body),
      409,
      'VERSION_CONFLICT',
    )
  }
})

test('same actor/key with differing concurrent intent has one winner and one idempotency conflict', async () => {
  const order = await fixture(),
    key = randomUUID()
  const results = await Promise.all([
    request(recordPath(order.id), input(order), key),
    request(recordPath(order.id), { ...input(order), note: 'Different' }, key),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'IDEMPOTENCY_CONFLICT',
  )
  assert.equal(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND' },
    }),
    1,
  )
})

test('two ADMIN identities, register/confirm and confirm/fail races have one version winner without duplicate refund history', async () => {
  for (const pair of [
    'record-record',
    'record-confirm',
    'confirm-confirm',
    'confirm-fail',
  ]) {
    const order = await fixture(),
      target = pair === 'record-record' ? null : await attempt(order)
    const left = pair.startsWith('record')
      ? request(recordPath(order.id), input(order))
      : request(actionPath(target!.id), { expectedVersion: 1 })
    const right =
      pair === 'record-record'
        ? request(
            recordPath(order.id),
            input(order),
            randomUUID(),
            cookies.secondAdmin,
          )
        : request(
            actionPath(
              target!.id,
              pair === 'confirm-fail' ? 'fail' : 'confirm',
            ),
            {
              expectedVersion: 1,
              ...(pair === 'confirm-fail' ? { reason: 'Bank rejected' } : {}),
            },
            randomUUID(),
            cookies.secondAdmin,
          )
    const results = await Promise.all([left, right])
    assert.equal(
      results.filter((r) => r.status === 200 || r.status === 201).length,
      1,
      JSON.stringify(results.map((r) => r.body)),
    )
    assert.equal(results.filter((r) => r.status === 409).length, 1)
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
      2,
    )
    assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      2,
    )
    assert.equal(
      await db.paymentTransaction.count({
        where: { orderId: order.id, kind: 'REFUND' },
      }),
      1,
    )
  }
})

test('faults at all six transaction stages fully roll back each refund operation and permit clean same-key retry', async () => {
  for (const operation of ['record', 'confirm', 'fail'])
    for (const table of [
      'PaymentTransaction',
      'Order',
      'OrderRevision',
      'OrderEvent',
      'AdminAuditLog',
      'IdempotencyRecord',
    ]) {
      const order = await fixture(),
        target = operation === 'record' ? null : await attempt(order),
        key = randomUUID()
      const path = target
          ? actionPath(target.id, operation)
          : recordPath(order.id),
        body =
          operation === 'record'
            ? input(order)
            : {
                expectedVersion: 1,
                ...(operation === 'fail' ? { reason: 'Bank rejected' } : {}),
              }
      sql(
        `CREATE TRIGGER Refund_test_failure BEFORE ${table === 'Order' || (table === 'PaymentTransaction' && operation !== 'record') ? 'UPDATE' : 'INSERT'} ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_REFUND_FAILURE';`,
      )
      try {
        await rejected(() => request(path, body, key), 503)
      } finally {
        sql('DROP TRIGGER Refund_test_failure;')
      }
      assert.equal(
        (await request(path, body, key)).status,
        operation === 'record' ? 201 : 200,
      )
      assert.equal(
        await db.orderRevision.count({ where: { orderId: order.id } }),
        2,
      )
    }
})

test('waiting HTTP refund confirmation rechecks changed order version/state under the parent lock', async () => {
  const order = await fixture(),
    refund = await attempt(order),
    entered = gate(),
    release = gate()
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
      entered.release()
      await release.wait
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PAID', version: { increment: 1 } },
      })
    },
    { timeout: 20000 },
  )
  await entered.wait
  const pending = request(actionPath(refund.id), { expectedVersion: 1 })
  release.release()
  await holder
  assert.equal((await pending).status, 409)
  const before = await snapshot()
  await rejected(
    () => request(actionPath(refund.id), { expectedVersion: 2 }),
    409,
    'ORDER_NOT_REFUNDABLE',
  )
  assert(isDeepStrictEqual(await snapshot(), before))
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: refund.id },
      })
    ).status,
    'PENDING',
  )
})

test('hidden completed SYSTEM_RENEWAL orders are concealed by every refund route', async () => {
  // Ordinary hidden orders are forbidden by the existing database source CHECK.
  // Use a valid hidden renewal for the HTTP visibility assertions below.
  await assert.rejects(() => fixture({ hidden: true }), /Order_creator_check/)
  const clock = await now(),
    day = 86400000
  const sub = await db.subscription.create({
    data: {
      userId: customer.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Existing entitlement',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      termSnapshot: 'Display',
      startedAt: new Date(clock.getTime() - day),
      expiresAt: new Date(clock.getTime() + day),
      renewalPriceFen: 1000,
    },
  })
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex')
  const renewal = await fixture({
    source: 'SYSTEM_RENEWAL',
    createdByAdminId: null,
    kind: 'RENEWAL',
    hidden: true,
    subscriptionId: sub.id,
    productTypeSnapshot: 'SUBSCRIPTION',
    servicePeriodUnitSnapshot: 'DAY',
    servicePeriodCountSnapshot: 1,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    paidAt: clock,
    paymentConfirmedAt: clock,
    fulfilledAt: clock,
    cancelledAt: null,
    renewalForPeriodStartAt: new Date(clock.getTime() - day),
    renewalPeriodStartAt: clock,
    renewalPeriodEndAt: new Date(clock.getTime() + day),
    billingAnchorSnapshotAt: clock,
    billingTimezoneSnapshot: 'Asia/Shanghai',
    billingRevisionSnapshot: 1,
    renewalRequestKeyHash: hash(),
    renewalRequestHash: hash(),
  })
  const refund = await attempt(renewal, { occurredAt: clock })
  await rejected(() => request(recordPath(renewal.id)), 404, 'NOT_FOUND')
  await rejected(
    () => request(recordPath(renewal.id), input(renewal)),
    404,
    'NOT_FOUND',
  )
  await rejected(
    () => request(actionPath(refund.id), { expectedVersion: 1 }),
    404,
    'NOT_FOUND',
  )
  await rejected(
    () =>
      request(actionPath(refund.id, 'fail'), {
        expectedVersion: 1,
        reason: 'Hidden',
      }),
    404,
    'NOT_FOUND',
  )
})

test('confirmations exceeding the five-connection pool complete without nested locator starvation', async () => {
  const targets = []
  for (let i = 0; i < 8; i++) {
    const order = await fixture()
    targets.push(await attempt(order))
  }
  const results = await Promise.all(
    targets.map((target) =>
      request(actionPath(target.id), { expectedVersion: 1 }),
    ),
  )
  assert.deepEqual(
    results.map((result) => result.status),
    Array(8).fill(200),
    JSON.stringify(results.map((result) => result.body)),
  )
})

test('refund confirmation holding the parent lock wins atomically against a competing conditional state writer', async () => {
  const order = await fixture(),
    refund = await attempt(order),
    lockName = 'refund-' + randomUUID()
  const original = await db.paymentTransaction.findMany({
    where: { orderId: order.id, kind: 'PAYMENT' },
  })
  sql(
    `CREATE TRIGGER Refund_test_commit_gate BEFORE INSERT ON AdminAuditLog FOR EACH ROW BEGIN IF NEW.entityId = '${refund.id}' THEN DO GET_LOCK('${lockName}', 0); DO SLEEP(1); DO RELEASE_LOCK('${lockName}'); END IF; END;`,
  )
  const confirmation = request(actionPath(refund.id), { expectedVersion: 1 })
  let competing: Promise<number> | undefined
  try {
    const stop = Date.now() + 5000
    while (
      !(
        await db.$queryRaw<
          { owner: bigint | null }[]
        >`SELECT IS_USED_LOCK(${lockName}) AS owner`
      )[0]!.owner
    ) {
      assert(
        Date.now() < stop,
        'Refund confirmation did not reach its audit barrier',
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    competing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
      return (
        await tx.order.updateMany({
          where: { id: order.id, version: 1, paymentStatus: 'REFUND_PENDING' },
          data: { paymentStatus: 'PAID', version: { increment: 1 } },
        })
      ).count
    })
    assert.equal((await confirmation).status, 200)
    assert.equal(await competing, 0)
  } finally {
    await Promise.allSettled([confirmation, ...(competing ? [competing] : [])])
    sql('DROP TRIGGER Refund_test_commit_gate;')
  }
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.deepEqual(saved, {
    ...order,
    paymentStatus: 'REFUNDED',
    version: 2,
    updatedAt: saved.updatedAt,
  })
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  assert.equal(
    await db.adminAuditLog.count({ where: { entityId: refund.id } }),
    1,
  )
  assert.deepEqual(
    await db.paymentTransaction.findMany({
      where: { orderId: order.id, kind: 'PAYMENT' },
    }),
    original,
  )
})
