import { after, before, test } from 'node:test'
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
import {
  cancelLockedOrder,
  cancellationSelect,
} from '../../src/modules/orders/cancel.ts'
import { orderTimeoutService } from '../../src/modules/orders/timeout.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
const sweep = orderTimeoutService(db),
  cookies: Record<string, string> = {}
let server: Server,
  base: string,
  admin: User,
  alice: User,
  bob: User,
  productId: string
const schema = {
  version: 1,
  fields: [
    {
      id: 'account',
      type: 'text',
      label: 'Account identifier',
      required: true,
    },
  ],
}
const body = (reason = '  Requested cancellation  ', expectedVersion = 1) => ({
  expectedVersion,
  reason,
})
async function session(user: User) {
  const token = newToken()
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  return COOKIE_NAME + '=' + token
}
async function fixture(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const source = extra.source ?? 'ADMIN'
  const order = await db.order.create({
    data: {
      orderNo: 'CANCEL-' + randomUUID().replaceAll('-', ''),
      userId: alice.id,
      productId,
      source,
      kind: 'INITIAL',
      createdByAdminId: source === 'ADMIN' ? admin.id : null,
      createdByUserId: source === 'USER' ? (extra.userId ?? alice.id) : null,
      productNameSnapshot: 'Frozen cancellation product',
      productDescriptionSnapshot: 'Frozen description',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      renewalPriceSnapshotFen: 900,
      termSnapshot: 'Display only',
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      formSchemaSnapshot: schema,
      formData: { account: 'PRIVATE_FORM_VALUE' },
      amountFen: 1000,
      contactEmailSnapshot: 'private-contact@example.com',
      internalNote: 'PRIVATE_NOTE',
      ...extra,
    },
  })
  await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(order),
      actorType: source === 'SYSTEM_RENEWAL' ? 'SYSTEM' : source,
      actorUserId:
        source === 'SYSTEM_RENEWAL'
          ? null
          : source === 'ADMIN'
            ? admin.id
            : order.userId,
    },
  })
  return order
}
async function payment(
  orderId: string,
  extra: Partial<Prisma.PaymentTransactionUncheckedCreateInput> = {},
) {
  return db.paymentTransaction.create({
    data: {
      orderId,
      kind: 'PAYMENT',
      channel: 'CASH',
      amountFen: 1000,
      status: 'PENDING',
      occurredAt: new Date(),
      createdByAdminId: admin.id,
      externalReference: randomUUID(),
      note: 'External evidence retained',
      ...extra,
    },
  })
}
async function paidFixture() {
  const now = new Date()
  const order = await fixture({
    paymentStatus: 'PAID',
    fulfillmentStatus: 'PROCESSING',
    paidAt: now,
    paymentConfirmedAt: now,
  })
  const receipt = await payment(order.id, {
    status: 'CONFIRMED',
    occurredAt: now,
    confirmedAt: now,
    confirmedByAdminId: admin.id,
  })
  return { order, receipt }
}
async function request(
  role: 'customer' | 'admin',
  id: string,
  data: unknown = body(),
  key: string | null = randomUUID(),
  cookie = cookies[role],
  origin = env.APP_BASE_URL,
) {
  const response = await fetch(
    base + '/api/v1/' + role + '/orders/' + id + '/cancel',
    {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'x-requested-with': 'MembershipStore',
        'content-type': 'application/json',
        ...(key === null ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify(data),
    },
  )
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }
}
async function snapshot(): Promise<Record<string, unknown[]>> {
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
    'Failed cancellation changed business data/history',
  )
}
function sql(input: string) {
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
      input: input.includes(' BEGIN ')
        ? 'DELIMITER $$\n' + input.replace(/;$/, '') + '$$\nDELIMITER ;\n'
        : input,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    },
  )
}
async function databaseNow() {
  return (
    await db.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
  )[0]!.now
}
async function expired(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return fixture({
    createdAt: new Date((await databaseNow()).getTime() - 86400000),
    ...extra,
  })
}
function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
before(async () => {
  admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const user = (status: User['status']) =>
    db.user.create({
      data: {
        role: 'CUSTOMER',
        status,
        loginEmail: randomUUID() + '@example.com',
        username: 'Customer',
        adminLabel: 'PRIVATE_LABEL',
      },
    })
  alice = await user('ACTIVE')
  bob = await user('ACTIVE')
  cookies.admin = await session(admin)
  cookies.customer = await session(alice)
  cookies.bob = await session(bob)
  cookies.pending = await session(await user('PENDING_ACTIVATION'))
  cookies.disabled = await session(await user('DISABLED'))
  productId = (
    await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Cancellation product',
        type: 'SUBSCRIPTION',
        priceFen: 1000,
        renewalPriceFen: 900,
        termLabel: 'Display only',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        formSchema: schema,
      },
    })
  ).id
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
})
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    )
  await db.$disconnect()
})

test('cancel HTTP endpoints require active persisted role Sessions, CSRF, ownership and safe 404s', async () => {
  const order = await fixture()
  for (const cookie of ['', cookies.pending, cookies.disabled])
    await rejected(
      () => request('customer', order.id, body(), randomUUID(), cookie),
      401,
    )
  await rejected(
    () => request('admin', order.id, body(), randomUUID(), cookies.customer),
    403,
  )
  await rejected(
    () => request('customer', order.id, body(), randomUUID(), cookies.admin),
    403,
  )
  await rejected(
    () => request('customer', order.id, body(), randomUUID(), cookies.bob),
    404,
    'NOT_FOUND',
  )
  await rejected(() => request('customer', randomUUID()), 404, 'NOT_FOUND')
  await rejected(
    () =>
      request(
        'customer',
        order.id,
        body(),
        randomUUID(),
        cookies.customer,
        'http://external.invalid',
      ),
    403,
  )
})

test('strict cancellation bodies validate versions, role-specific reasons, keys and immutable fields', async () => {
  const order = await fixture()
  for (const data of [
    {},
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: '1' },
    { expectedVersion: 1, reason: null },
    body('x'.repeat(501)),
    { ...body(), userId: bob.id },
    { ...body(), paymentStatus: 'PAID' },
    { ...body(), actorType: 'SYSTEM' },
  ])
    await rejected(() => request('customer', order.id, data), 400)
  for (const data of [{ expectedVersion: 1 }, body('  ')])
    await rejected(() => request('admin', order.id, data), 400)
  await rejected(() => request('admin', order.id, body(), null), 400)
  await rejected(() => request('admin', 'invalid-id'), 400)
  await rejected(() => request('admin', order.id, body('', 2)), 400)
})

test('CUSTOMER cancels own USER/ADMIN ordinary orders with optional normalized reason and exact safe DTO', async () => {
  for (const source of ['USER', 'ADMIN'] as const) {
    const order = await fixture({ source }),
      before = await snapshot()
    const result = await request('customer', order.id, {
      expectedVersion: 1,
      ...(source === 'USER' ? { reason: '  ' } : {}),
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.body.order.fulfillmentStatus, 'CANCELLED')
    assert.equal(result.body.order.paymentStatus, 'UNPAID')
    assert.equal(result.body.order.remainingSeconds, 0)
    assert.equal(result.body.order.version, 2)
    const read = await fetch(base + '/api/v1/customer/orders/' + order.id, {
      headers: { cookie: cookies.customer },
    })
    assert.deepEqual(
      Object.keys(result.body.order).sort(),
      Object.keys((await read.json()).order).sort(),
    )
    for (const field of [
      'internalNote',
      'customer',
      'creator',
      'cancellationReason',
    ])
      assert(!Object.hasOwn(result.body.order, field))
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(saved.cancellationReason, null)
    for (const field of Object.keys(order) as (keyof typeof order)[])
      if (
        ![
          'version',
          'updatedAt',
          'cancelledAt',
          'cancellationReason',
          'fulfillmentStatus',
        ].includes(field)
      )
        assert.deepEqual(saved[field], order[field], field)
    const history = await db.orderRevision.findMany({
      where: { orderId: order.id },
      orderBy: { version: 'asc' },
    })
    assert.equal(history.length, 2)
    assert.deepEqual(history[0]!.snapshotJson, buildOrderSnapshot(order))
    assert.deepEqual(history[1]!.snapshotJson, buildOrderSnapshot(saved))
    assert.equal(history[1]!.actorType, 'USER')
    assert.equal(history[1]!.actorUserId, alice.id)
    const event = await db.orderEvent.findFirstOrThrow({
      where: { orderId: order.id },
    })
    assert.equal(event.actorType, 'USER')
    assert.equal(event.actorUserId, alice.id)
    assert.equal(event.actorAdminId, null)
    assert.equal(
      await db.adminAuditLog.count({ where: { entityId: order.id } }),
      0,
    )
    const after = await snapshot()
    for (const table of [
      'PaymentTransaction',
      'Subscription',
      'SubscriptionEvent',
    ])
      assert.deepEqual(after[table], before[table])
  }
})

test('pending verification customer cancellation closes ALL unconfirmed PAYMENT attempts without deleting external evidence', async () => {
  const order = await fixture({ paymentStatus: 'PENDING_VERIFICATION' })
  const pending = await Promise.all([payment(order.id), payment(order.id)])
  const failed = await payment(order.id, { status: 'FAILED' })
  const refund = await payment(order.id, { kind: 'REFUND' })
  const result = await request(
    'customer',
    order.id,
    body('  Changed my mind  '),
  )
  assert.equal(result.status, 200)
  assert.equal(result.body.order.paymentStatus, 'UNPAID')
  for (const original of pending) {
    const saved = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: original.id },
    })
    for (const field of Object.keys(original) as (keyof typeof original)[])
      if (!['status', 'note', 'updatedAt'].includes(field))
        assert.deepEqual(saved[field], original[field], field)
    assert.equal(saved.status, 'FAILED')
    assert.equal(saved.note, 'ORDER_CANCELLED')
  }
  for (const unchanged of [failed, refund])
    assert.deepEqual(
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: unchanged.id },
      }),
      unchanged,
    )
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      .cancellationReason,
    'Changed my mind',
  )
})

test('ADMIN unpaid cancellation requires reason and records sanitized Audit', async () => {
  const order = await fixture(),
    result = await request('admin', order.id)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.order.internalNote, order.internalNote)
  assert.equal(result.body.order.cancellationReason, 'Requested cancellation')
  const audit = await db.adminAuditLog.findFirstOrThrow({
    where: { entityId: order.id },
  })
  assert.equal(audit.action, 'ORDER_CANCELLED')
  assert.equal(audit.actorAdminId, admin.id)
  const event = await db.orderEvent.findFirstOrThrow({
    where: { orderId: order.id },
  })
  assert.equal(event.actorAdminId, admin.id)
  assert.equal(event.actorUserId, null)
  for (const text of [JSON.stringify(audit), JSON.stringify(event)])
    for (const value of [
      'PRIVATE_FORM_VALUE',
      'private-contact@example.com',
      'PRIVATE_NOTE',
      'PRIVATE_LABEL',
    ])
      assert(!text.includes(value))
})

test('ADMIN pending-verification cancellation requires reason, retains every attempt and atomically persists one history/response', async () => {
  const order = await fixture({ paymentStatus: 'PENDING_VERIFICATION' })
  const attempts = await Promise.all([payment(order.id), payment(order.id)])
  const failed = await payment(order.id, { status: 'FAILED' })
  const refund = await payment(order.id, { kind: 'REFUND' })
  for (const data of [{ expectedVersion: 1 }, body('   ')])
    await rejected(() => request('admin', order.id, data), 400, 'INVALID_INPUT')
  const before = await snapshot(),
    key = randomUUID()
  const first = await request(
    'admin',
    order.id,
    body('  Admin cancellation  '),
    key,
  )
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.order.paymentStatus, 'UNPAID')
  assert.equal(first.body.order.fulfillmentStatus, 'CANCELLED')
  assert.equal(first.body.order.version, 2)
  assert.equal(first.body.order.cancellationReason, 'Admin cancellation')
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  for (const field of Object.keys(order) as (keyof typeof order)[])
    if (
      ![
        'version',
        'updatedAt',
        'cancelledAt',
        'cancellationReason',
        'paymentStatus',
        'fulfillmentStatus',
      ].includes(field)
    )
      assert.deepEqual(saved[field], order[field], field)
  assert(saved.cancelledAt)
  for (const original of attempts) {
    const updated = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: original.id },
    })
    assert.deepEqual(updated, {
      ...original,
      status: 'FAILED',
      note: 'ORDER_CANCELLED',
      updatedAt: updated.updatedAt,
    })
  }
  for (const original of [failed, refund])
    assert.deepEqual(
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: original.id },
      }),
      original,
    )
  const revision = await db.orderRevision.findFirstOrThrow({
    where: { orderId: order.id, version: 2 },
  })
  assert.deepEqual(revision.snapshotJson, buildOrderSnapshot(saved))
  assert.equal(revision.actorType, 'ADMIN')
  assert.equal(revision.actorUserId, admin.id)
  assert.equal(revision.reason, 'Admin cancellation')
  assert.deepEqual(
    (
      await db.orderRevision.findFirstOrThrow({
        where: { orderId: order.id, version: 1 },
      })
    ).snapshotJson,
    buildOrderSnapshot(order),
  )
  const event = await db.orderEvent.findFirstOrThrow({
    where: { orderId: order.id },
  })
  assert.equal(event.actorType, 'ADMIN')
  assert.equal(event.actorAdminId, admin.id)
  assert.equal(event.actorUserId, null)
  assert.equal(event.note, 'Admin cancellation')
  const audit = await db.adminAuditLog.findFirstOrThrow({
    where: { entityId: order.id },
  })
  assert.equal(audit.actorAdminId, admin.id)
  assert.equal(audit.action, 'ORDER_CANCELLED')
  assert.equal(audit.reason, 'Admin cancellation')
  const after = await snapshot()
  for (const table of [
    'OrderRevision',
    'OrderEvent',
    'AdminAuditLog',
    'IdempotencyRecord',
  ])
    assert.equal(after[table].length, before[table].length + 1)
  for (const table of Object.keys(before))
    if (
      ![
        'Order',
        'PaymentTransaction',
        'OrderRevision',
        'OrderEvent',
        'AdminAuditLog',
        'IdempotencyRecord',
      ].includes(table)
    )
      assert.deepEqual(after[table], before[table])
  assert.equal(after.Order.length, before.Order.length)
  assert.equal(
    after.PaymentTransaction.length,
    before.PaymentTransaction.length,
  )
  assert.deepEqual(
    (await request('admin', order.id, body('Admin cancellation'), key)).body,
    first.body,
  )
  assert(isDeepStrictEqual(await snapshot(), after))
})

test('pending-verification summary cannot bypass confirmed transaction or order payment facts for either manual role', async () => {
  for (const variant of [
    'paidAt',
    'paymentConfirmedAt',
    'confirmed-status',
    'confirmed-time',
  ]) {
    const now = new Date(),
      order = await fixture({
        paymentStatus: 'PENDING_VERIFICATION',
        ...(variant === 'paidAt' ? { paidAt: now } : {}),
        ...(variant === 'paymentConfirmedAt'
          ? { paymentConfirmedAt: now }
          : {}),
      })
    if (variant.startsWith('confirmed-'))
      await payment(order.id, {
        status: variant === 'confirmed-status' ? 'CONFIRMED' : 'PENDING',
        confirmedAt: variant === 'confirmed-time' ? now : null,
      })
    for (const role of ['admin', 'customer'] as const)
      await rejected(
        () => request(role, order.id),
        409,
        'ORDER_NOT_CANCELLABLE',
      )
  }
})

test('ADMIN paid cancellation yields REFUND_PENDING and preserves full confirmed receipt and payment times', async () => {
  const { order, receipt } = await paidFixture(),
    pending = await payment(order.id),
    before = await snapshot()
  await rejected(
    () => request('customer', order.id),
    409,
    'ORDER_NOT_CANCELLABLE',
  )
  const result = await request('admin', order.id)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.order.paymentStatus, 'REFUND_PENDING')
  assert.equal(result.body.order.fulfillmentStatus, 'CANCELLED')
  assert.equal(result.body.order.paidAt, order.paidAt!.toISOString())
  assert.equal(
    result.body.order.paymentConfirmedAt,
    order.paymentConfirmedAt!.toISOString(),
  )
  assert.equal(result.body.order.fulfilledAt, null)
  assert.deepEqual(
    await db.paymentTransaction.findUniqueOrThrow({
      where: { id: receipt.id },
    }),
    receipt,
  )
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: pending.id },
      })
    ).status,
    'FAILED',
  )
  assert.equal(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND' },
    }),
    0,
  )
  assert.deepEqual((await snapshot()).Subscription, before.Subscription)
})

test('paid cancellation refuses missing, partial, duplicate and inconsistent confirmed payment facts', async () => {
  for (const variant of [
    'absent',
    'partial',
    'overpaid',
    'duplicate',
    'wrong-occurrence',
    'wrong-confirmation',
    'pending',
    'no-paidAt',
    'no-confirmation',
  ]) {
    const now = new Date(),
      order = await fixture({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
        paidAt: variant === 'no-paidAt' ? null : now,
        paymentConfirmedAt: variant === 'no-confirmation' ? null : now,
      })
    if (variant !== 'absent')
      await payment(order.id, {
        status: variant === 'pending' ? 'PENDING' : 'CONFIRMED',
        amountFen:
          variant === 'partial' ? 500 : variant === 'overpaid' ? 1500 : 1000,
        occurredAt:
          variant === 'wrong-occurrence' ? new Date(now.getTime() - 1000) : now,
        confirmedAt:
          variant === 'wrong-confirmation'
            ? new Date(now.getTime() + 1000)
            : now,
        confirmedByAdminId: admin.id,
      })
    if (variant === 'duplicate')
      await payment(order.id, {
        status: 'CONFIRMED',
        occurredAt: now,
        confirmedAt: now,
        confirmedByAdminId: admin.id,
      })
    await rejected(
      () => request('admin', order.id),
      409,
      'ORDER_NOT_CANCELLABLE',
    )
  }
})

test('ADMIN zero cancellation remains NOT_REQUIRED without any new money or entitlement records', async () => {
  const order = await fixture({
    amountFen: 0,
    paymentStatus: 'NOT_REQUIRED',
    fulfillmentStatus: 'PROCESSING',
  })
  await rejected(
    () => request('customer', order.id),
    409,
    'ORDER_NOT_CANCELLABLE',
  )
  const before = await snapshot(),
    result = await request('admin', order.id)
  assert.equal(result.status, 200)
  assert.equal(result.body.order.paymentStatus, 'NOT_REQUIRED')
  assert.equal(result.body.order.fulfillmentStatus, 'CANCELLED')
  assert.equal(result.body.order.paidAt, null)
  assert.equal(result.body.order.paymentConfirmedAt, null)
  const after = await snapshot()
  for (const table of [
    'PaymentTransaction',
    'Subscription',
    'SubscriptionEvent',
  ])
    assert.deepEqual(after[table], before[table])
})

test('completed, cancelled, paid facts and other incompatible ordinary states cannot be cancelled', async () => {
  for (const extra of [
    { fulfillmentStatus: 'COMPLETED' },
    { fulfillmentStatus: 'CANCELLED' },
    { fulfillmentStatus: 'FAILED' },
    { fulfillmentStatus: 'PROCESSING' },
    { paymentStatus: 'REFUND_PENDING' },
    { paymentStatus: 'REFUNDED' },
    { fulfilledAt: new Date() },
    { cancelledAt: new Date() },
    { paidAt: new Date() },
    { paymentConfirmedAt: new Date() },
  ] as Partial<Prisma.OrderUncheckedCreateInput>[]) {
    const order = await fixture(extra)
    for (const role of ['customer', 'admin'] as const)
      await rejected(
        () => request(role, order.id),
        409,
        'ORDER_NOT_CANCELLABLE',
      )
  }
  const order = await fixture()
  await payment(order.id, {
    status: 'CONFIRMED',
    confirmedAt: new Date(),
    confirmedByAdminId: admin.id,
  })
  for (const role of ['customer', 'admin'] as const)
    await rejected(() => request(role, order.id), 409, 'ORDER_NOT_CANCELLABLE')
})

test('same normalized key/intent returns original role DTO; different reasons, versions and order IDs conflict', async () => {
  for (const role of ['customer', 'admin'] as const) {
    const order = await fixture(),
      other = await fixture(),
      key = randomUUID(),
      first = await request(role, order.id, body(), key)
    assert.equal(first.status, 200)
    const before = await snapshot()
    assert.deepEqual(
      (await request(role, order.id, body('Requested cancellation'), key)).body,
      first.body,
    )
    assert(isDeepStrictEqual(await snapshot(), before))
    for (const data of [body('Other'), body('Requested cancellation', 2)])
      await rejected(
        () => request(role, order.id, data, key),
        409,
        'IDEMPOTENCY_CONFLICT',
      )
    await rejected(
      () => request(role, other.id, body(), key),
      409,
      'IDEMPOTENCY_CONFLICT',
    )
    await rejected(
      () => request(role, order.id, body('Again', 2)),
      409,
      'ORDER_NOT_CANCELLABLE',
    )
    await rejected(() => request(role, order.id), 409, 'VERSION_CONFLICT')
    const record = await db.idempotencyRecord.findUniqueOrThrow({
      where: {
        actorUserId_keyHash: {
          actorUserId: role === 'admin' ? admin.id : alice.id,
          keyHash: createHash('sha256').update(key).digest('hex'),
        },
      },
    })
    assert.deepEqual(record.responseJson, first.body)
    assert(!JSON.stringify(record).includes(key))
  }
  const order = await fixture(),
    key = randomUUID()
  const first = await request('customer', order.id, { expectedVersion: 1 }, key)
  assert.deepEqual(
    (await request('customer', order.id, body('  '), key)).body,
    first.body,
  )
})

test('true concurrent same-key requests replay one cancellation; competing keys/actors have one version winner', async () => {
  for (const role of ['customer', 'admin'] as const) {
    const order = await fixture(),
      key = randomUUID(),
      before = await snapshot()
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(role, order.id, body(), key)),
    )
    assert(
      results.every((r) => r.status === 200),
      JSON.stringify(results.map((r) => r.body)),
    )
    assert(results.every((r) => isDeepStrictEqual(r.body, results[0]!.body)))
    const after = await snapshot()
    for (const table of ['OrderRevision', 'OrderEvent', 'IdempotencyRecord'])
      assert.equal(after[table].length, before[table].length + 1)
    assert.equal(
      after.AdminAuditLog.length,
      before.AdminAuditLog.length + (role === 'admin' ? 1 : 0),
    )
  }
  const order = await fixture(),
    results = await Promise.all([
      request('admin', order.id),
      request('customer', order.id),
    ])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'VERSION_CONFLICT',
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
})

test('concurrent different reasons with the same actor/key have one success and one idempotency conflict', async () => {
  const order = await fixture(),
    key = randomUUID(),
    before = await snapshot()
  const results = await Promise.all(
    ['First reason', 'Second reason'].map((reason) =>
      request('customer', order.id, body(reason), key),
    ),
  )
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'IDEMPOTENCY_CONFLICT',
  )
  const after = await snapshot()
  for (const table of ['OrderRevision', 'OrderEvent', 'IdempotencyRecord'])
    assert.equal(after[table].length, before[table].length + 1)
  assert.deepEqual(after.AdminAuditLog, before.AdminAuditLog)
})

test('paid cancellation failures at final Audit/idempotency stage preserve receipt and roll back refund-pending history', async () => {
  for (const table of ['AdminAuditLog', 'IdempotencyRecord']) {
    const { order, receipt } = await paidFixture(),
      key = randomUUID()
    const attempt = await payment(order.id)
    sql(
      `CREATE TRIGGER Cancel_test_failure BEFORE INSERT ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_PAID_CANCEL_FAILURE';`,
    )
    try {
      await rejected(() => request('admin', order.id, body(), key), 503)
    } finally {
      sql('DROP TRIGGER Cancel_test_failure;')
    }
    assert.deepEqual(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
      order,
    )
    for (const original of [receipt, attempt])
      assert.deepEqual(
        await db.paymentTransaction.findUniqueOrThrow({
          where: { id: original.id },
        }),
        original,
      )
    assert.equal((await request('admin', order.id, body(), key)).status, 200)
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      2,
    )
  }
})

test('faults at every manual transaction stage roll back Order, attempts, Revision, Event, Audit and idempotency', async () => {
  for (const role of ['customer', 'admin'] as const)
    for (const table of [
      'Order',
      'PaymentTransaction',
      'OrderRevision',
      'OrderEvent',
      ...(role === 'admin' ? ['AdminAuditLog'] : []),
      'IdempotencyRecord',
    ]) {
      const order = await fixture(
          role === 'admin' ? { paymentStatus: 'PENDING_VERIFICATION' } : {},
        ),
        key = randomUUID()
      await payment(order.id)
      sql(
        `CREATE TRIGGER Cancel_test_failure BEFORE ${['Order', 'PaymentTransaction'].includes(table) ? 'UPDATE' : 'INSERT'} ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_CANCEL_FAILURE';`,
      )
      try {
        await rejected(() => request(role, order.id, body(), key), 503)
      } finally {
        sql('DROP TRIGGER Cancel_test_failure;')
      }
      assert.equal((await request(role, order.id, body(), key)).status, 200)
      assert.equal(
        await db.orderRevision.count({ where: { orderId: order.id } }),
        2,
      )
    }
})

test('hidden immutable SYSTEM_RENEWAL orders cannot be cancelled by any role or timeout scan', async () => {
  const now = await databaseNow(),
    day = 86400000
  const sub = await db.subscription.create({
    data: {
      userId: alice.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Legacy subscription',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      termSnapshot: 'Display',
      startedAt: new Date(now.getTime() - day),
      expiresAt: new Date(now.getTime() + day),
      renewalPriceFen: 900,
    },
  })
  const order = await fixture({
    source: 'SYSTEM_RENEWAL',
    kind: 'RENEWAL',
    hidden: true,
    subscriptionId: sub.id,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    paidAt: now,
    paymentConfirmedAt: now,
    fulfilledAt: now,
    renewalForPeriodStartAt: new Date(now.getTime() - day),
    renewalPeriodStartAt: now,
    renewalPeriodEndAt: new Date(now.getTime() + day),
    billingAnchorSnapshotAt: now,
    billingTimezoneSnapshot: 'Asia/Shanghai',
    billingRevisionSnapshot: 1,
    renewalRequestKeyHash: createHash('sha256')
      .update(randomUUID())
      .digest('hex'),
    renewalRequestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  })
  for (const role of ['customer', 'admin'] as const)
    await rejected(() => request(role, order.id), 409, 'ORDER_NOT_CANCELLABLE')
  await rejected(
    () => request('customer', order.id, body(), randomUUID(), cookies.bob),
    404,
  )
  const before = await snapshot()
  assert.equal((await sweep()).cancelled, 0)
  assert(isDeepStrictEqual(await snapshot(), before))
})

test('database-time 24h inclusive boundary; SYSTEM history, pending closure and repeat/restart scans', async () => {
  const now = await databaseNow()
  const fresh = await fixture({
    createdAt: new Date(now.getTime() - 86400000 + 600000),
  })
  const exact = await fixture({ createdAt: new Date(now.getTime() - 86400000) })
  const old = await expired({ paymentStatus: 'PENDING_VERIFICATION' }),
    attempt = await payment(old.id)
  const before = await snapshot(),
    result = await sweep()
  assert.equal(result.failed, 0)
  assert.equal(result.cancelled, 2)
  assert.deepEqual(
    await db.order.findUniqueOrThrow({ where: { id: fresh.id } }),
    fresh,
  )
  for (const order of [exact, old]) {
    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(saved.version, 2)
    assert.equal(saved.fulfillmentStatus, 'CANCELLED')
    assert.equal(saved.paymentStatus, 'UNPAID')
    assert.equal(saved.cancellationReason, 'PAYMENT_TIMEOUT')
    assert(saved.cancelledAt!.getTime() >= now.getTime())
    const revision = await db.orderRevision.findFirstOrThrow({
      where: { orderId: order.id, version: 2 },
    })
    assert.equal(revision.actorType, 'SYSTEM')
    assert.equal(revision.actorUserId, null)
    assert.deepEqual(revision.snapshotJson, buildOrderSnapshot(saved))
    const event = await db.orderEvent.findFirstOrThrow({
      where: { orderId: order.id },
    })
    assert.equal(event.actorType, 'SYSTEM')
    assert.equal(event.actorUserId, null)
    assert.equal(event.actorAdminId, null)
    assert.equal(event.note, 'PAYMENT_TIMEOUT')
    assert(!JSON.stringify(event).includes('PRIVATE_FORM_VALUE'))
  }
  const closed = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: attempt.id },
  })
  assert.equal(closed.status, 'FAILED')
  assert.equal(closed.note, 'PAYMENT_TIMEOUT')
  assert.equal(closed.externalReference, attempt.externalReference)
  const after = await snapshot()
  for (const table of [
    'AdminAuditLog',
    'IdempotencyRecord',
    'Subscription',
    'SubscriptionEvent',
  ])
    assert.deepEqual(after[table], before[table])
  assert.equal((await sweep()).cancelled, 0)
  assert.equal((await orderTimeoutService(db)()).cancelled, 0)
  assert(isDeepStrictEqual(await snapshot(), after))
})

test('timeout scans exclude paid, zero, terminal, hidden and incomplete payment-fact rows', async () => {
  const items = []
  for (const extra of [
    { paymentStatus: 'PAID', fulfillmentStatus: 'PROCESSING' },
    {
      paymentStatus: 'NOT_REQUIRED',
      fulfillmentStatus: 'PROCESSING',
      amountFen: 0,
    },
    { fulfillmentStatus: 'COMPLETED' },
    { fulfillmentStatus: 'CANCELLED' },
    { paidAt: new Date() },
    { paymentConfirmedAt: new Date() },
    { fulfilledAt: new Date() },
    { cancelledAt: new Date() },
  ] as Partial<Prisma.OrderUncheckedCreateInput>[])
    items.push(await expired(extra))
  const before = await snapshot(),
    result = await sweep()
  assert.equal(result.cancelled, 0)
  assert.equal(result.failed, 0)
  assert(isDeepStrictEqual(await snapshot(), before))
})

test('multiple real concurrent workers and manual cancellation race produce only one terminal history', async () => {
  const rows = await Promise.all(Array.from({ length: 6 }, () => expired()))
  const results = await Promise.all([
    orderTimeoutService(db)(),
    orderTimeoutService(db)(),
  ])
  assert.equal(
    results.reduce((n, r) => n + r.cancelled, 0),
    rows.length,
  )
  assert.equal(
    results.reduce((n, r) => n + r.failed, 0),
    0,
  )
  for (const order of rows) {
    assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      2,
    )
  }
  const order = await expired()
  const [manual] = await Promise.all([request('customer', order.id), sweep()])
  assert([200, 409].includes(manual.status))
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
})

test('bounded 100-row batches use deterministic ordering and SKIP LOCKED without waiting', async () => {
  const rows: Awaited<ReturnType<typeof fixture>>[] = []
  for (let i = 0; i < 101; i++)
    rows.push(
      await expired({
        createdAt: new Date(
          (await databaseNow()).getTime() - 90000000 - (101 - i) * 1000,
        ),
      }),
    )
  const first = await sweep()
  assert.equal(first.scanned, 100)
  assert.equal(first.cancelled, 100)
  assert.equal(first.failed, 0)
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: rows[100]!.id } }))
      .version,
    1,
  )
  assert.equal((await sweep()).cancelled, 1)
  // Lock skipping uses a short transaction; do not hold an idle adapter
  // connection across the entire separate 100-row throughput assertion.
  const locked = await expired(),
    other = await expired()
  const ready = gate(),
    release = gate()
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${locked.id} FOR UPDATE`
      ready.release()
      await release.wait
    },
    { timeout: 20000 },
  )
  await ready.wait
  try {
    const result = await sweep()
    assert.equal(result.scanned, 2)
    assert.equal(result.cancelled, 1)
    assert.equal(result.failed, 0)
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: locked.id } })).version,
      1,
    )
  } finally {
    release.release()
    await holder
  }
  const result = await sweep()
  assert.equal(result.cancelled, 1)
  assert.equal(result.failed, 0)
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: other.id } })).version,
    2,
  )
  assert.equal((await sweep()).cancelled, 0)
})

test('per-row worker failures roll back every stage, continue healthy rows, and retry on next scan', async () => {
  for (const table of [
    'Order',
    'PaymentTransaction',
    'OrderRevision',
    'OrderEvent',
  ]) {
    const bad = await expired(),
      attempt = await payment(bad.id),
      healthy = await expired()
    const column = table === 'Order' ? 'id' : 'orderId'
    sql(
      `CREATE TRIGGER Cancel_test_failure BEFORE ${['Order', 'PaymentTransaction'].includes(table) ? 'UPDATE' : 'INSERT'} ON \`${table}\` FOR EACH ROW BEGIN IF NEW.\`${column}\` = '${bad.id}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_TIMEOUT_FAILURE'; END IF; END;`,
    )
    try {
      const result = await sweep()
      assert.equal(result.failed, 1)
      assert.equal(result.cancelled, 1)
      assert.deepEqual(
        await db.order.findUniqueOrThrow({ where: { id: bad.id } }),
        bad,
      )
      assert.deepEqual(
        await db.paymentTransaction.findUniqueOrThrow({
          where: { id: attempt.id },
        }),
        attempt,
      )
      assert.equal(
        await db.orderRevision.count({ where: { orderId: bad.id } }),
        1,
      )
      assert.equal(await db.orderEvent.count({ where: { orderId: bad.id } }), 0)
      assert.equal(
        (await db.order.findUniqueOrThrow({ where: { id: healthy.id } }))
          .fulfillmentStatus,
        'CANCELLED',
      )
    } finally {
      sql('DROP TRIGGER Cancel_test_failure;')
    }
    assert.equal((await sweep()).cancelled, 1)
  }
})

// Test-only confirmation writer: exercise the shared lock protocol, not a new
// payment API. Eligibility and deadline are rechecked AFTER acquiring the lock.
async function confirmForRace(
  id: string,
  entered = gate(),
  release?: ReturnType<typeof gate>,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${id} FOR UPDATE`
      // A SQL statement's UTC_TIMESTAMP is fixed at statement start. Query
      // the deadline separately AFTER any lock wait, just as future production
      // payment confirmation must do.
      const eligible = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM \`Order\` WHERE id = ${id} AND paymentStatus = 'UNPAID' AND fulfillmentStatus = 'NOT_STARTED' AND cancelledAt IS NULL AND createdAt > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`
      entered.release()
      if (!eligible.length) return false
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
      )[0]!.now
      await tx.order.update({
        where: { id },
        data: {
          paymentStatus: 'PAID',
          fulfillmentStatus: 'PROCESSING',
          paidAt: now,
          paymentConfirmedAt: now,
          version: { increment: 1 },
        },
      })
      await tx.paymentTransaction.create({
        data: {
          orderId: id,
          kind: 'PAYMENT',
          channel: 'CASH',
          amountFen: 1000,
          status: 'CONFIRMED',
          occurredAt: now,
          confirmedAt: now,
          createdByAdminId: admin.id,
          confirmedByAdminId: admin.id,
        },
      })
      const order = await tx.order.findUniqueOrThrow({ where: { id } })
      await tx.orderRevision.create({
        data: {
          orderId: id,
          version: order.version,
          snapshotSchemaVersion: 1,
          snapshotJson: buildOrderSnapshot(order),
          actorType: 'ADMIN',
          actorUserId: admin.id,
        },
      })
      await tx.orderEvent.create({
        data: {
          orderId: id,
          eventType: 'PAYMENT_CONFIRMED',
          actorType: 'ADMIN',
          actorAdminId: admin.id,
          toStateJson: {
            version: order.version,
            paymentStatus: 'PAID',
            fulfillmentStatus: 'PROCESSING',
          },
        },
      })
      await tx.adminAuditLog.create({
        data: {
          actorAdminId: admin.id,
          action: 'TEST_PAYMENT_CONFIRMED',
          entityType: 'Order',
          entityId: id,
          afterJson: { version: order.version, paymentStatus: 'PAID' },
        },
      })
      if (release) await release.wait
      return true
    },
    { timeout: 20000 },
  )
}

test('payment confirmation lock wins before deadline; timeout skips its held lock then observes PAID', async () => {
  const now = await databaseNow(),
    order = await fixture({
      createdAt: new Date(now.getTime() - 86400000 + 1500),
    })
  const entered = gate(),
    release = gate(),
    writer = confirmForRace(order.id, entered, release)
  await entered.wait
  try {
    // Cross the deadline using DATABASE time, not a mocked process clock.
    while (
      (await databaseNow()).getTime() <
      order.createdAt.getTime() + 86400000
    )
      await new Promise((r) => setTimeout(r, 25))
    const result = await sweep()
    assert.equal(result.cancelled, 0)
    assert.equal(result.failed, 0)
  } finally {
    release.release()
  }
  assert.equal(await writer, true)
  assert.equal((await sweep()).cancelled, 0)
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(saved.paymentStatus, 'PAID')
  assert.equal(saved.version, 2)
  assert.equal(saved.cancelledAt, null)
  assert(saved.paidAt!.getTime() < order.createdAt.getTime() + 86400000)
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  assert.equal(
    await db.adminAuditLog.count({ where: { entityId: order.id } }),
    1,
  )
})

test('confirmation waiting on an unrelated lock rechecks database deadline after acquiring it', async () => {
  const now = await databaseNow(),
    order = await fixture({
      createdAt: new Date(now.getTime() - 86400000 + 1500),
    })
  const entered = gate(),
    release = gate()
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
      entered.release()
      await release.wait
    },
    { timeout: 20000 },
  )
  await entered.wait
  const confirmation = confirmForRace(order.id)
  try {
    while (
      (await databaseNow()).getTime() <
      order.createdAt.getTime() + 86400000
    )
      await new Promise((r) => setTimeout(r, 25))
  } finally {
    release.release()
    await holder
  }
  assert.equal(await confirmation, false)
  assert.deepEqual(
    await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    order,
  )
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
    0,
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    1,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 0)
  assert.equal(
    await db.adminAuditLog.count({ where: { entityId: order.id } }),
    0,
  )
  assert.equal((await sweep()).cancelled, 1)
})

test('timeout lock wins; waiting confirmation rechecks state and cannot resurrect cancelled order', async () => {
  const order = await expired(),
    entered = gate(),
    release = gate()
  const timeout = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
      const locked = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        select: cancellationSelect,
      })
      await cancelLockedOrder(tx, locked, {
        type: 'SYSTEM',
        id: null,
        reason: 'PAYMENT_TIMEOUT',
      })
      entered.release()
      await release.wait
    },
    { timeout: 20000 },
  )
  await entered.wait
  let finished = false
  const confirmation = confirmForRace(order.id).then((r) => {
    finished = true
    return r
  })
  try {
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(finished, false)
  } finally {
    release.release()
  }
  await timeout
  assert.equal(await confirmation, false)
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
    0,
  )
  assert.equal(
    await db.adminAuditLog.count({ where: { entityId: order.id } }),
    0,
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
})
