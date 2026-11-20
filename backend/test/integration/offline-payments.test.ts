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
let server: Server, base: string, admin: User, customer: User, productId: string
const paymentKeys = [
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
const recordPath = (id: string) => `/orders/${id}/payment-transactions`
const actionPath = (id: string, action = 'confirm') =>
  `/payment-transactions/${id}/${action}`
async function now() {
  return (
    await db.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`
  )[0]!.now
}
async function fixture(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const order = await db.order.create({
    data: {
      orderNo: 'PAYMENT-' + randomUUID().replaceAll('-', ''),
      userId: customer.id,
      productId,
      source: 'ADMIN',
      kind: 'ONE_TIME',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Frozen payment product',
      productDescriptionSnapshot: 'Frozen description',
      productTypeSnapshot: 'ONE_TIME',
      priceSnapshotFen: 1000,
      termSnapshot: 'Once',
      formSchemaSnapshot: { version: 1, fields: [] },
      formData: {},
      amountFen: 1000,
      contactEmailSnapshot: 'contact@example.com',
      internalNote: 'PRIVATE_ORDER_NOTE',
      createdAt: new Date((await now()).getTime() - 1000),
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
  return order
}
type Order = Awaited<ReturnType<typeof fixture>>
const input = (order: Order, expectedVersion = order.version) => ({
  expectedVersion,
  amountFen: 1000,
  channel: 'CASH',
  occurredAt: new Date(order.createdAt.getTime() + 100).toISOString(),
  externalReference: 'PRIVATE_REFERENCE',
  note: 'PRIVATE_ORIGINAL_NOTE',
})
async function attempt(
  order: Order,
  extra: Partial<Prisma.PaymentTransactionUncheckedCreateInput> = {},
) {
  return db.paymentTransaction.create({
    data: {
      orderId: order.id,
      kind: 'PAYMENT',
      channel: 'CASH',
      amountFen: 1000,
      occurredAt: new Date(order.createdAt.getTime() + 100),
      createdByAdminId: admin.id,
      externalReference: 'PRIVATE_REFERENCE',
      note: 'PRIVATE_ORIGINAL_NOTE',
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
    'Rejected request changed business rows or history',
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
async function waitUntil(deadline: number) {
  const stop = Date.now() + 10000
  while ((await now()).getTime() < deadline) {
    assert(Date.now() < stop, 'Database clock wait exceeded bound')
    await new Promise((r) => setTimeout(r, 25))
  }
}
before(async () => {
  admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  customer = await db.user.create({
    data: {
      role: 'CUSTOMER',
      status: 'ACTIVE',
      loginEmail: randomUUID() + '@example.com',
    },
  })
  for (const [name, user] of [
    ['admin', admin],
    ['customer', customer],
    [
      'disabled',
      await db.user.create({
        data: { loginEmail: randomUUID() + '@example.com', status: 'DISABLED' },
      }),
    ],
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
        name: 'Payment product',
        type: 'ONE_TIME',
        priceFen: 1000,
        termLabel: 'Once',
      },
    })
  ).id
})
// Each independent scenario gets the real, unmodified limiter with a fresh
// application lifetime. The large negative matrix must not consume later
// scenarios' 120-request allowance or mask their database assertions with 429s.
beforeEach(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
})
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    )
})
after(() => db.$disconnect())

test('all four payment endpoints enforce persisted ADMIN Sessions, CSRF and strict paths/queries', async () => {
  const order = await fixture(),
    payment = await attempt(order)
  for (const [path, data] of [
    [recordPath(order.id), undefined],
    [recordPath(order.id), input(order)],
    [actionPath(payment.id), { expectedVersion: 1 }],
    [
      actionPath(payment.id, 'fail'),
      { expectedVersion: 1, reason: 'Not received' },
    ],
  ] as const) {
    for (const cookie of ['', cookies.disabled])
      await rejected(() => request(path, data, randomUUID(), cookie), 401)
    await rejected(
      () => request(path, data, randomUUID(), cookies.customer),
      403,
    )
    if (data)
      await rejected(
        () =>
          request(
            path,
            data,
            randomUUID(),
            cookies.admin,
            'http://untrusted.example',
          ),
        403,
      )
  }
  await rejected(() => request(recordPath(order.id) + '?userId=other'), 400)
  await rejected(() => request(recordPath('invalid')), 400)
  for (const path of [recordPath(randomUUID()), actionPath(randomUUID())])
    await rejected(
      () =>
        request(
          path,
          path.includes('/orders/') ? input(order) : { expectedVersion: 1 },
        ),
      404,
    )
})

test('registration validates amount, channel, version, keys, UTC dates and forged managed fields over HTTP', async () => {
  const order = await fixture()
  for (const amountFen of [undefined, 0, -1, 1.5, '1000', 2147483648])
    await rejected(
      () => request(recordPath(order.id), { ...input(order), amountFen }),
      400,
    )
  for (const occurredAt of [
    undefined,
    'invalid',
    '2026-02-30T00:00:00.000Z',
    '2026-11-19T00:00:00Z',
    '2026-11-19T00:00:00.000+08:00',
  ])
    await rejected(
      () => request(recordPath(order.id), { ...input(order), occurredAt }),
      400,
    )
  for (const extra of [
    { channel: 'CARD' },
    { expectedVersion: 0 },
    { actorId: admin.id },
    { status: 'CONFIRMED' },
    { note: 'x'.repeat(501) },
    { externalReference: 'x'.repeat(121) },
  ])
    await rejected(
      () => request(recordPath(order.id), { ...input(order), ...extra }),
      400,
    )
  await rejected(
    () => request(recordPath(order.id), input(order), null),
    400,
    'INVALID_IDEMPOTENCY_KEY',
  )
  for (const occurredAt of [
    new Date(order.createdAt.getTime() - 1),
    new Date((await now()).getTime() + 60000),
  ])
    await rejected(
      () =>
        request(recordPath(order.id), {
          ...input(order),
          occurredAt: occurredAt.toISOString(),
        }),
      400,
      'PAYMENT_TIME_INVALID',
    )
})

test('all five channels register actual amounts including mismatches, without confirmation or entitlements', async () => {
  for (const channel of [
    'WECHAT',
    'ALIPAY',
    'BANK_TRANSFER',
    'CASH',
    'OTHER',
  ]) {
    const order = await fixture(
        ['WECHAT', 'ALIPAY'].includes(channel)
          ? {
              source: channel === 'WECHAT' ? 'USER' : 'ADMIN',
              createdByUserId: channel === 'WECHAT' ? customer.id : null,
              createdByAdminId: channel === 'WECHAT' ? null : admin.id,
              kind: 'INITIAL',
              productTypeSnapshot: 'SUBSCRIPTION',
              servicePeriodUnitSnapshot: 'MONTH',
              servicePeriodCountSnapshot: 1,
            }
          : {},
      ),
      data = {
        ...input(order),
        channel,
        amountFen: channel === 'OTHER' ? 995 : 1000,
      }
    const response = await request(recordPath(order.id), data)
    assert.equal(response.status, 201, JSON.stringify(response.body))
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(response.body.order.version, 2)
    assert.equal(response.body.order.paymentStatus, 'PENDING_VERIFICATION')
    assert.equal(response.body.order.fulfillmentStatus, 'NOT_STARTED')
    assert.equal(response.body.order.paidAt, null)
    assert.equal(response.body.order.paymentConfirmedAt, null)
    const saved = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: response.body.paymentTransaction.id },
    })
    assert.equal(saved.amountFen, data.amountFen)
    assert.equal(saved.channel, channel)
    assert.equal(saved.status, 'PENDING')
    assert.equal(saved.kind, 'PAYMENT')
    assert.equal(saved.createdByAdminId, admin.id)
    assert.equal(saved.confirmedAt, null)
    assert.equal(saved.confirmedByAdminId, null)
    assert.equal(saved.occurredAt.toISOString(), data.occurredAt)
    assert.equal(
      await db.subscription.count({ where: { sourceOrderId: order.id } }),
      0,
    )
    assert.equal(
      await db.paymentTransaction.count({ where: { orderId: order.id } }),
      1,
    )
  }
})

test('GET is read-only, paginated, stably sorted, PAYMENT-only and uses an exact evidence allowlist', async () => {
  const order = await fixture(),
    createdAt = await now()
  const rows = await Promise.all(
    Array.from({ length: 23 }, () => attempt(order, { createdAt })),
  )
  await attempt(order, { kind: 'REFUND' })
  const foreign = await fixture()
  await attempt(foreign)
  const before = await snapshot()
  const response = await request(recordPath(order.id)),
    second = await request(recordPath(order.id) + '?page=2&pageSize=20')
  assert.equal(response.status, 200)
  assert.equal(response.body.total, 23)
  assert.equal(response.body.page, 1)
  assert.equal(response.body.pageSize, 20)
  const expected = rows
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => row.id)
  assert.deepEqual(
    [...response.body.items, ...second.body.items].map(
      (row: { id: string }) => row.id,
    ),
    expected,
  )
  for (const row of response.body.items) {
    assert.deepEqual(Object.keys(row).sort(), paymentKeys)
    assert.equal(row.orderId, order.id)
    assert.equal(row.kind, 'PAYMENT')
  }
  assert(isDeepStrictEqual(await snapshot(), before))
  for (const query of ['page=0', 'pageSize=101', 'pageSize=1.5', 'kind=REFUND'])
    await rejected(() => request(recordPath(order.id) + '?' + query), 400)
})

test('ordinary positive unpaid/unconfirmed order and no payment facts are required for every write', async () => {
  for (const extra of [
    {
      amountFen: 0,
      paymentStatus: 'NOT_REQUIRED',
      fulfillmentStatus: 'PROCESSING',
    },
    {
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PROCESSING',
      paidAt: await now(),
      paymentConfirmedAt: await now(),
    },
    { paymentStatus: 'REFUND_PENDING' },
    { paymentStatus: 'REFUNDED' },
    { fulfillmentStatus: 'CANCELLED', cancelledAt: await now() },
    { fulfillmentStatus: 'COMPLETED', fulfilledAt: await now() },
    { paidAt: await now() },
    { paymentConfirmedAt: await now() },
    { createdAt: new Date((await now()).getTime() - 86400000) },
  ] as Partial<Prisma.OrderUncheckedCreateInput>[]) {
    const order = await fixture(extra),
      payment = await attempt(order)
    for (const [path, data] of [
      [recordPath(order.id), input(order)],
      [actionPath(payment.id), { expectedVersion: 1 }],
      [
        actionPath(payment.id, 'fail'),
        { expectedVersion: 1, reason: 'No receipt' },
      ],
    ] as const)
      await rejected(() => request(path, data), 409, 'ORDER_NOT_PAYABLE')
  }
  for (const extra of [
    { status: 'CONFIRMED' as const },
    { confirmedAt: await now() },
  ]) {
    const order = await fixture(),
      target = await attempt(order)
    await attempt(order, extra)
    await rejected(
      () => request(recordPath(order.id), input(order)),
      409,
      'ORDER_NOT_PAYABLE',
    )
    await rejected(
      () => request(actionPath(target.id), { expectedVersion: 1 }),
      409,
      'ORDER_NOT_PAYABLE',
    )
    await rejected(
      () =>
        request(actionPath(target.id, 'fail'), {
          expectedVersion: 1,
          reason: 'No receipt',
        }),
      409,
      'ORDER_NOT_PAYABLE',
    )
  }
})

test('multiple attempts require individual explicit failure before exact full confirmation; raw evidence stays intact', async () => {
  const order = await fixture()
  const first = await request(recordPath(order.id), input(order)),
    firstId = first.body.paymentTransaction.id
  const second = await request(recordPath(order.id), {
      ...input(order, 2),
      amountFen: 555,
    }),
    secondId = second.body.paymentTransaction.id
  assert.equal(second.status, 201)
  assert.equal(second.body.order.version, 3)
  await rejected(
    () => request(actionPath(firstId), { expectedVersion: 3 }),
    409,
    'OTHER_PENDING_PAYMENTS',
  )
  await rejected(
    () => request(actionPath(secondId), { expectedVersion: 3 }),
    409,
    'PAYMENT_AMOUNT_MISMATCH',
  )
  const original = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: secondId },
  })
  for (const reason of [undefined, '', ' ', 'x'.repeat(501)])
    await rejected(
      () =>
        request(actionPath(secondId, 'fail'), { expectedVersion: 3, reason }),
      400,
    )
  const failed = await request(actionPath(secondId, 'fail'), {
    expectedVersion: 3,
    reason: '  Incorrect claimed amount  ',
  })
  assert.equal(failed.status, 200)
  assert.equal(failed.body.order.version, 4)
  assert.equal(failed.body.order.paymentStatus, 'PENDING_VERIFICATION')
  const saved = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: secondId },
  })
  assert.deepEqual(saved, {
    ...original,
    status: 'FAILED',
    updatedAt: saved.updatedAt,
  })
  await rejected(
    () =>
      request(actionPath(secondId, 'fail'), {
        expectedVersion: 4,
        reason: 'Again',
      }),
    409,
    'PAYMENT_NOT_PENDING',
  )
  await rejected(
    () => request(actionPath(secondId), { expectedVersion: 4 }),
    409,
    'PAYMENT_NOT_PENDING',
  )
  const confirmed = await request(actionPath(firstId), { expectedVersion: 4 })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.order.version, 5)
  assert.equal(confirmed.body.order.paymentStatus, 'PAID')
  assert.equal(confirmed.body.order.fulfillmentStatus, 'PROCESSING')
  assert.equal(
    confirmed.body.order.paidAt,
    first.body.paymentTransaction.occurredAt,
  )
  assert.equal(
    confirmed.body.order.paymentConfirmedAt,
    confirmed.body.paymentTransaction.confirmedAt,
  )
  assert.equal(confirmed.body.paymentTransaction.confirmedByAdminId, admin.id)
  assert(
    new Date(confirmed.body.order.paidAt) <=
      new Date(confirmed.body.order.paymentConfirmedAt),
  )
  assert.equal(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
    0,
  )
  assert.equal(confirmed.body.order.fulfilledAt, null)
  await rejected(
    () => request(actionPath(firstId), { expectedVersion: 5 }),
    409,
  )
  await rejected(
    () =>
      request(actionPath(firstId, 'fail'), {
        expectedVersion: 5,
        reason: 'Again',
      }),
    409,
  )
})

test('failing the last pending attempt restores UNPAID and preserves note, occurrence and legacy entry time', async () => {
  const legacy = new Date((await now()).getTime() - 500),
    order = await fixture({
      paymentStatus: 'PENDING_VERIFICATION',
      paymentRecordedAt: legacy,
    }),
    payment = await attempt(order)
  const response = await request(actionPath(payment.id, 'fail'), {
    expectedVersion: 1,
    reason: 'No funds arrived',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.order.paymentStatus, 'UNPAID')
  assert.equal(response.body.order.fulfillmentStatus, 'NOT_STARTED')
  const saved = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: payment.id },
  })
  assert.deepEqual(saved, {
    ...payment,
    status: 'FAILED',
    updatedAt: saved.updatedAt,
  })
  assert.deepEqual(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      .paymentRecordedAt,
    legacy,
  )
})

test('confirmation validates target identity, kind, status, amount and occurredAt against database time', async () => {
  for (const extra of [
    { kind: 'REFUND' as const },
    { status: 'FAILED' as const },
    { amountFen: 999 },
    { occurredAt: new Date((await now()).getTime() + 60000) },
  ]) {
    const order = await fixture(),
      payment = await attempt(order, extra)
    await rejected(
      () => request(actionPath(payment.id), { expectedVersion: 1 }),
      extra.kind === 'REFUND' ? 404 : 409,
    )
  }
  const order = await fixture(),
    payment = await attempt(order, {
      occurredAt: new Date(order.createdAt.getTime() - 1),
    })
  await rejected(
    () => request(actionPath(payment.id), { expectedVersion: 1 }),
    409,
    'PAYMENT_TIME_INVALID',
  )
})

test('hidden completed SYSTEM_RENEWAL orders and their PAYMENT attempts are not visible or mutable in T17', async () => {
  const clock = await now(),
    day = 86400000
  const sub = await db.subscription.create({
    data: {
      userId: customer.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Existing subscription',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      termSnapshot: 'Display',
      startedAt: new Date(clock.getTime() - day),
      expiresAt: new Date(clock.getTime() + day),
      renewalPriceFen: 1000,
    },
  })
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex')
  const order = await fixture({
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
    renewalForPeriodStartAt: new Date(clock.getTime() - day),
    renewalPeriodStartAt: clock,
    renewalPeriodEndAt: new Date(clock.getTime() + day),
    billingAnchorSnapshotAt: clock,
    billingTimezoneSnapshot: 'Asia/Shanghai',
    billingRevisionSnapshot: 1,
    renewalRequestKeyHash: hash(),
    renewalRequestHash: hash(),
  })
  const payment = await attempt(order)
  await rejected(() => request(recordPath(order.id)), 404)
  await rejected(() => request(recordPath(order.id), input(order)), 404)
  await rejected(
    () => request(actionPath(payment.id), { expectedVersion: 1 }),
    404,
  )
  await rejected(
    () =>
      request(actionPath(payment.id, 'fail'), {
        expectedVersion: 1,
        reason: 'No receipt',
      }),
    404,
  )
})

test('confirmation copies the actual occurrence but preserves legacy paymentRecordedAt and all frozen fields', async () => {
  const entry = new Date((await now()).getTime() - 500),
    order = await fixture({ paymentRecordedAt: entry }),
    payment = await attempt(order)
  const response = await request(actionPath(payment.id), { expectedVersion: 1 })
  assert.equal(response.status, 200)
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.deepEqual(saved.paymentRecordedAt, entry)
  assert.deepEqual(saved.paidAt, payment.occurredAt)
  for (const field of Object.keys(order) as (keyof typeof order)[])
    if (
      ![
        'version',
        'updatedAt',
        'paymentStatus',
        'fulfillmentStatus',
        'paidAt',
        'paymentConfirmedAt',
      ].includes(field)
    )
      assert.deepEqual(saved[field], order[field], field)
})

test('every success has exactly one complete revision/event/audit/idempotent response and safe DTOs', async () => {
  const order = await fixture(),
    recorded = await request(recordPath(order.id), input(order)),
    id = recorded.body.paymentTransaction.id
  const expectedSnapshots = [
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  ]
  const failed = await request(actionPath(id, 'fail'), {
    expectedVersion: 2,
    reason: 'No receipt',
  })
  expectedSnapshots.push(
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  )
  const second = await request(recordPath(order.id), input(order, 3))
  expectedSnapshots.push(
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  )
  const confirmed = await request(
    actionPath(second.body.paymentTransaction.id),
    { expectedVersion: 4 },
  )
  expectedSnapshots.push(
    buildOrderSnapshot(
      await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    ),
  )
  for (const [index, response] of [
    recorded,
    failed,
    second,
    confirmed,
  ].entries()) {
    assert.equal(response.body.order.version, index + 2)
    assert.deepEqual(
      Object.keys(response.body.paymentTransaction).sort(),
      paymentKeys,
    )
    const revision = await db.orderRevision.findFirstOrThrow({
      where: { orderId: order.id, version: index + 2 },
    })
    assert.equal(revision.actorType, 'ADMIN')
    assert.equal(revision.actorUserId, admin.id)
    assert.equal(revision.reason, index === 1 ? 'No receipt' : null)
    assert.deepEqual(revision.snapshotJson, expectedSnapshots[index])
  }
  const savedOrder = await db.order.findUniqueOrThrow({
    where: { id: order.id },
  })
  const last = await db.orderRevision.findFirstOrThrow({
    where: { orderId: order.id, version: 5 },
  })
  assert.deepEqual(last.snapshotJson, buildOrderSnapshot(savedOrder))
  assert.equal(savedOrder.paymentRecordedAt, null)
  const events = await db.orderEvent.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
  })
  assert.equal(events.length, 4)
  assert.deepEqual(
    events.map((e) => e.eventType),
    ['PAYMENT_RECORDED', 'NOTE', 'PAYMENT_RECORDED', 'PAYMENT_CONFIRMED'],
  )
  assert.equal(events[1]!.note, 'No receipt')
  const audits = await db.adminAuditLog.findMany({
    where: { entityId: { in: [id, second.body.paymentTransaction.id] } },
  })
  assert.equal(audits.length, 4)
  for (const row of [...events, ...audits])
    for (const secret of [
      'PRIVATE_REFERENCE',
      'PRIVATE_ORIGINAL_NOTE',
      'PRIVATE_ORDER_NOTE',
      'passwordHash',
      'tokenHash',
    ])
      assert(!JSON.stringify(row).includes(secret))
  for (const audit of audits) {
    assert.equal(audit.actorAdminId, admin.id)
    assert.equal(audit.entityType, 'PaymentTransaction')
  }
  assert.equal(
    await db.idempotencyRecord.count({
      where: {
        actorUserId: admin.id,
        responseJson: { path: '$.order.id', equals: order.id },
      },
    }),
    4,
  )
})

test('sequential and concurrent idempotency replay exact original responses after later transitions', async () => {
  const order = await fixture(),
    key = randomUUID(),
    body = input(order)
  const duplicate = await Promise.all([
    request(recordPath(order.id), body, key),
    request(recordPath(order.id), body, key),
  ])
  assert.deepEqual(
    duplicate.map((r) => r.status),
    [201, 201],
  )
  assert.deepEqual(duplicate[0]!.body, duplicate[1]!.body)
  const id = duplicate[0]!.body.paymentTransaction.id,
    confirmationKey = randomUUID()
  const confirms = await Promise.all([
    request(actionPath(id), { expectedVersion: 2 }, confirmationKey),
    request(actionPath(id), { expectedVersion: 2 }, confirmationKey),
  ])
  assert.deepEqual(
    confirms.map((r) => r.status),
    [200, 200],
  )
  assert.deepEqual(confirms[0]!.body, confirms[1]!.body)
  assert.deepEqual(
    (await request(recordPath(order.id), body, key)).body,
    duplicate[0]!.body,
  )
  assert.deepEqual(
    (await request(actionPath(id), { expectedVersion: 2 }, confirmationKey))
      .body,
    confirms[0]!.body,
  )
  const record = await db.idempotencyRecord.findUniqueOrThrow({
    where: {
      actorUserId_keyHash: {
        actorUserId: admin.id,
        keyHash: createHash('sha256').update(key).digest('hex'),
      },
    },
  })
  assert(!JSON.stringify(record).includes(key))
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
    1,
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    3,
  )
  for (const action of [
    () => request(recordPath(order.id), { ...body, amountFen: 999 }, key),
    () =>
      request(
        actionPath(id, 'fail'),
        { expectedVersion: 2, reason: 'No receipt' },
        key,
      ),
  ])
    await rejected(action, 409, 'IDEMPOTENCY_CONFLICT')
})

test('same key different concurrent intent has one success and one idempotency conflict', async () => {
  const order = await fixture(),
    key = randomUUID()
  const results = await Promise.all([
    request(recordPath(order.id), input(order), key),
    request(recordPath(order.id), { ...input(order), amountFen: 999 }, key),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'IDEMPOTENCY_CONFLICT',
  )
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
    1,
  )
})

test('different-key register/register, register/confirm, confirm/confirm and confirm/fail compete on one version', async () => {
  for (const pair of [
    'record-record',
    'record-confirm',
    'confirm-confirm',
    'confirm-fail',
  ]) {
    const order = await fixture(),
      payment = pair === 'record-record' ? null : await attempt(order)
    const record = () => request(recordPath(order.id), input(order)),
      confirm = () => request(actionPath(payment!.id), { expectedVersion: 1 }),
      fail = () =>
        request(actionPath(payment!.id, 'fail'), {
          expectedVersion: 1,
          reason: 'No receipt',
        })
    const [left, right] =
      pair === 'record-record'
        ? [record, record]
        : pair === 'record-confirm'
          ? [record, confirm]
          : pair === 'confirm-confirm'
            ? [confirm, confirm]
            : [confirm, fail]
    const results = await Promise.all([left!(), right!()])
    assert.equal(
      results.filter((r) => r.status < 300).length,
      1,
      JSON.stringify(results.map((r) => r.body)),
    )
    assert.equal(results.filter((r) => r.status === 409).length, 1)
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
      2,
    )
    assert.equal(
      await db.orderRevision.count({ where: { orderId: order.id } }),
      2,
    )
    assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  }
})

test('failure replay and stale versions cannot append extra history or overwrite evidence', async () => {
  const order = await fixture(),
    payment = await attempt(order),
    key = randomUUID(),
    body = { expectedVersion: 1, reason: 'No receipt' }
  const duplicates = await Promise.all([
    request(actionPath(payment.id, 'fail'), body, key),
    request(actionPath(payment.id, 'fail'), body, key),
  ])
  const first = duplicates[0]!
  assert.equal(duplicates[1]!.status, 200)
  assert.deepEqual(first.body, duplicates[1]!.body)
  assert.equal(first.status, 200)
  const before = await snapshot()
  assert.deepEqual(
    (await request(actionPath(payment.id, 'fail'), body, key)).body,
    first.body,
  )
  assert(isDeepStrictEqual(await snapshot(), before))
  await rejected(
    () => request(recordPath(order.id), input(order)),
    409,
    'VERSION_CONFLICT',
  )
  await rejected(
    () =>
      request(actionPath(payment.id, 'fail'), { ...body, expectedVersion: 2 }),
    409,
    'PAYMENT_NOT_PENDING',
  )
})

test('faults at every write stage fully roll back all tables for record, confirm and fail; same-key retry succeeds', async () => {
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
        payment = operation === 'record' ? null : await attempt(order),
        key = randomUUID()
      const path = payment
        ? actionPath(payment.id, operation)
        : recordPath(order.id)
      const body =
        operation === 'record'
          ? input(order)
          : {
              expectedVersion: 1,
              ...(operation === 'fail' ? { reason: 'No receipt' } : {}),
            }
      sql(
        `CREATE TRIGGER Payment_test_failure BEFORE ${table === 'Order' || (table === 'PaymentTransaction' && operation !== 'record') ? 'UPDATE' : 'INSERT'} ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_PAYMENT_FAILURE';`,
      )
      try {
        await rejected(() => request(path, body, key), 503)
      } finally {
        sql('DROP TRIGGER Payment_test_failure;')
      }
      const result = await request(path, body, key)
      assert.equal(
        result.status,
        operation === 'record' ? 201 : 200,
        JSON.stringify(result.body),
      )
      assert.equal(
        await db.orderRevision.count({ where: { orderId: order.id } }),
        2,
      )
    }
})

test('24-hour inclusive cutoff rejects registration, confirmation and failure and permits SYSTEM cancellation', async () => {
  const order = await fixture({
      createdAt: new Date((await now()).getTime() - 86400000),
    }),
    payment = await attempt(order)
  for (const [path, body] of [
    [recordPath(order.id), input(order)],
    [actionPath(payment.id), { expectedVersion: 1 }],
    [
      actionPath(payment.id, 'fail'),
      { expectedVersion: 1, reason: 'No receipt' },
    ],
  ] as const)
    await rejected(() => request(path, body), 409)
  await sweep()
  const cancelled = await db.order.findUniqueOrThrow({
    where: { id: order.id },
  })
  assert.equal(cancelled.fulfillmentStatus, 'CANCELLED')
  assert.equal(cancelled.paymentStatus, 'UNPAID')
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: payment.id },
      })
    ).status,
    'FAILED',
  )
  await rejected(
    () => request(actionPath(payment.id), { expectedVersion: 2 }),
    409,
  )
})

test('each real HTTP payment operation rechecks database deadline after waiting for Order lock', async () => {
  for (const operation of ['record', 'confirm', 'fail']) {
    const order = await fixture({
        createdAt: new Date((await now()).getTime() - 86400000 + 1500),
      }),
      payment = await attempt(order)
    const entered = gate(),
      release = gate(),
      holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
          entered.release()
          await release.wait
        },
        { timeout: 20000 },
      )
    await entered.wait
    const response = request(
      operation === 'record'
        ? recordPath(order.id)
        : actionPath(payment.id, operation),
      operation === 'record'
        ? input(order)
        : {
            expectedVersion: 1,
            ...(operation === 'fail' ? { reason: 'No receipt' } : {}),
          },
    )
    const before = await snapshot()
    try {
      await waitUntil(order.createdAt.getTime() + 86400000)
    } finally {
      release.release()
      await holder
    }
    assert.equal((await response).status, 409)
    assert(isDeepStrictEqual(await snapshot(), before))
  }
})

test('deadline crossing during PaymentTransaction write rolls back confirmation and its earlier transaction change', async () => {
  const order = await fixture({
      createdAt: new Date((await now()).getTime() - 86400000 + 1500),
    }),
    payment = await attempt(order)
  sql(
    `CREATE TRIGGER Payment_test_delay BEFORE UPDATE ON PaymentTransaction FOR EACH ROW BEGIN IF NEW.id = '${payment.id}' THEN DO SLEEP(2); END IF; END;`,
  )
  try {
    await rejected(
      () => request(actionPath(payment.id), { expectedVersion: 1 }),
      409,
      'ORDER_NOT_PAYABLE',
    )
  } finally {
    sql('DROP TRIGGER Payment_test_delay;')
  }
})

test('real HTTP confirmation wins before deadline and SYSTEM skip/recheck never cancels the paid order', async () => {
  // Previous deadline rejection cases intentionally leave expired unpaid rows.
  // Drain those through the real worker before asserting this race has no
  // cancellations; retain their audited history instead of deleting fixtures.
  await sweep()
  const order = await fixture({
      createdAt: new Date((await now()).getTime() - 86400000 + 1500),
    }),
    payment = await attempt(order)
  const lockName = 'payment-' + randomUUID()
  sql(
    `CREATE TRIGGER Payment_test_commit_gate BEFORE INSERT ON AdminAuditLog FOR EACH ROW BEGIN IF NEW.entityId = '${payment.id}' THEN DO GET_LOCK('${lockName}', 0); DO SLEEP(2); DO RELEASE_LOCK('${lockName}'); END IF; END;`,
  )
  const response = request(actionPath(payment.id), { expectedVersion: 1 })
  try {
    const stop = Date.now() + 5000
    while (
      !(
        await db.$queryRaw<
          { owner: bigint | null }[]
        >`SELECT IS_USED_LOCK(${lockName}) AS owner`
      )[0]!.owner
    ) {
      assert(Date.now() < stop, 'Confirmation did not reach its audit barrier')
      await new Promise((r) => setTimeout(r, 10))
    }
    await waitUntil(order.createdAt.getTime() + 86400000)
    const results = await Promise.all([sweep(), sweep()])
    assert(results.every((r) => r.cancelled === 0 && r.failed === 0))
    const result = await response
    assert.equal(result.status, 200, JSON.stringify(result.body))
  } finally {
    await response
    sql('DROP TRIGGER Payment_test_commit_gate;')
  }
  assert.equal((await sweep()).cancelled, 0)
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(saved.paymentStatus, 'PAID')
  assert.equal(saved.fulfillmentStatus, 'PROCESSING')
  assert.equal(saved.cancelledAt, null)
  assert.equal(saved.version, 2)
})

test('concurrent HTTP confirmations exceeding the five-connection pool finish without nested connection starvation', async () => {
  const orders = await Promise.all(Array.from({ length: 8 }, () => fixture()))
  const payments = await Promise.all(orders.map((order) => attempt(order)))
  const responses = await Promise.all(
    payments.map((payment) =>
      request(actionPath(payment.id), { expectedVersion: 1 }),
    ),
  )
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.order.version, 2)
    assert.equal(response.body.order.paymentStatus, 'PAID')
    assert.equal(response.body.paymentTransaction.id, payments[index]!.id)
    assert.equal(
      await db.orderRevision.count({ where: { orderId: orders[index]!.id } }),
      2,
    )
  }
})

test('SYSTEM transaction holds Order first; waiting real HTTP confirmation cannot revive timeout-cancelled attempt', async () => {
  const order = await fixture({
      createdAt: new Date((await now()).getTime() - 86400000),
    }),
    payment = await attempt(order),
    entered = gate(),
    release = gate()
  const timeout = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
      await cancelLockedOrder(
        tx,
        await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          select: cancellationSelect,
        }),
        { type: 'SYSTEM', id: null, reason: 'PAYMENT_TIMEOUT' },
      )
      entered.release()
      await release.wait
    },
    { timeout: 20000 },
  )
  await entered.wait
  let finished = false
  const response = request(actionPath(payment.id), { expectedVersion: 1 }).then(
    (r) => {
      finished = true
      return r
    },
  )
  try {
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(finished, false)
  } finally {
    release.release()
  }
  await timeout
  assert.equal((await response).status, 409)
  assert.equal(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: payment.id },
      })
    ).status,
    'FAILED',
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
})
