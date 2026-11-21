import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'
import type { Order, User } from '../../src/generated/prisma/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
let server: Server,
  base: string,
  admin: User,
  alice: User,
  bob: User,
  pending: User
let productId = '',
  hiddenId = '',
  legacyId = ''
const cookies: Record<string, string> = {}
const orders: Order[] = []
const schema = {
  version: 1,
  fields: [
    {
      id: 'account',
      type: 'text',
      label: 'Original account label',
      required: true,
      defaultValue: 'editor-only identifier',
    },
  ],
}
const date = (day: number) =>
  new Date(`2028-01-${String(day).padStart(2, '0')}T00:00:00.000Z`)

async function session(
  userId: string,
  extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
      ...extra,
    },
  })
  return COOKIE_NAME + '=' + token
}
async function request(path: string, cookie = cookies.admin, method = 'GET') {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      cookie,
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : '{}',
  })
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }
}
before(async () => {
  // Direct synthetic fixtures only, guarded by integrationEnvironment; never Seed.
  admin =
    (await db.user.findFirst({ where: { role: 'ADMIN' } })) ??
    (await db.user.create({
      data: {
        loginEmail: 'orders-owner@example.com',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    }))
  alice = await db.user.create({
    data: {
      loginEmail: 'orders-alice@example.com',
      username: 'Order Alice',
      adminLabel: 'PRIVATE_ALICE_LABEL',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      passwordHash: 'synthetic-not-a-login-hash',
      notificationEmail: 'alice-notifications@example.com',
    },
  })
  bob = await db.user.create({
    data: {
      loginEmail: 'orders-bob@example.com',
      username: 'Order Bob',
      adminLabel: 'PRIVATE_BOB_LABEL',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  })
  pending = await db.user.create({
    data: {
      loginEmail: 'orders-pending@example.com',
      role: 'CUSTOMER',
      status: 'PENDING_ACTIVATION',
    },
  })
  cookies.admin = await session(admin.id)
  cookies.alice = await session(alice.id)
  cookies.bob = await session(bob.id)
  cookies.expired = await session(alice.id, {
    expiresAt: new Date(Date.now() - 1000),
  })
  cookies.revoked = await session(alice.id, { revokedAt: new Date() })
  const disabled = await db.user.create({
    data: {
      loginEmail: 'orders-disabled@example.com',
      role: 'CUSTOMER',
      status: 'DISABLED',
    },
  })
  cookies.disabled = await session(disabled.id)
  const product = await db.product.create({
    data: {
      slug: 'orders-' + randomUUID(),
      name: 'Original product',
      description: 'Original description',
      type: 'SUBSCRIPTION',
      priceFen: 12900,
      renewalPriceFen: 9900,
      termLabel: 'Original calendar month',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      formSchema: schema,
    },
  })
  productId = product.id
  const nameOverrides: Record<number, string> = {
    11: 'Frozen O\'Reilly + C++ & /?# "quoted" 100%_ready\\path 中文',
    12: 'Unrelated service Alpha',
    13: 'Unrelated service Beta',
    14: String.raw`100X_ready\path`,
    15: String.raw`100%Xready\path`,
    16: '100%_readypath',
  }
  const matrix = [
    [alice, 'USER', 'INITIAL', 'UNPAID', 'NOT_STARTED'],
    [alice, 'ADMIN', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [bob, 'ADMIN', 'INITIAL', 'PAID', 'COMPLETED'],
    [alice, 'ADMIN', 'ONE_TIME', 'UNPAID', 'CANCELLED'],
    [pending, 'ADMIN', 'ONE_TIME', 'UNPAID', 'NOT_STARTED'],
    [bob, 'USER', 'INITIAL', 'PENDING_VERIFICATION', 'NOT_STARTED'],
    [alice, 'ADMIN', 'INITIAL', 'REFUND_PENDING', 'PROCESSING'],
    [bob, 'ADMIN', 'ONE_TIME', 'REFUNDED', 'CANCELLED'],
    [alice, 'USER', 'ONE_TIME', 'PAID', 'FAILED'],
    [alice, 'USER', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [bob, 'ADMIN', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [alice, 'ADMIN', 'ONE_TIME', 'PAID', 'PROCESSING'],
    // Same-owner/status distractors make ignoring search observable for both customers.
    [alice, 'USER', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [bob, 'ADMIN', 'ONE_TIME', 'PAID', 'PROCESSING'],
    // Each differs from the literal LIKE target in exactly one escaped character.
    [alice, 'USER', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [alice, 'ADMIN', 'ONE_TIME', 'PAID', 'PROCESSING'],
    [alice, 'USER', 'ONE_TIME', 'PAID', 'PROCESSING'],
  ] as const
  for (const [
    index,
    [user, source, kind, paymentStatus, fulfillmentStatus],
  ] of matrix.entries()) {
    const legacy = index === 3
    orders.push(
      await db.order.create({
        data: {
          orderNo: 'READ-' + String(index + 1).padStart(3, '0'),
          userId: user.id,
          productId,
          source,
          kind,
          createdByAdminId: source === 'ADMIN' ? admin.id : null,
          createdByUserId: source === 'USER' ? user.id : null,
          productNameSnapshot:
            nameOverrides[index] ??
            (index % 2 === 0 ? 'Frozen Alpha' : 'Frozen Beta'),
          productDescriptionSnapshot: 'Frozen original description',
          productTypeSnapshot: kind === 'INITIAL' ? 'SUBSCRIPTION' : 'ONE_TIME',
          priceSnapshotFen: legacy ? null : 12900,
          termSnapshot: 'Frozen calendar month',
          servicePeriodUnitSnapshot: legacy ? null : 'MONTH',
          servicePeriodCountSnapshot: legacy ? null : 1,
          formSchemaSnapshot: legacy ? Prisma.DbNull : schema,
          formData: legacy
            ? Prisma.DbNull
            : {
                account:
                  user === alice
                    ? 'alice-original-account'
                    : 'other-original-account',
              },
          amountFen: 12800 + index,
          renewalPriceSnapshotFen: kind === 'INITIAL' ? 9900 : null,
          contactEmailSnapshot: user.loginEmail,
          targetIdentifier: 'non-sensitive-target-' + index,
          paymentStatus,
          fulfillmentStatus,
          internalNote: 'PRIVATE_ORDER_NOTE_' + index,
          paidAt: ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(paymentStatus)
            ? date(index + 1)
            : null,
          paymentConfirmedAt: ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(
            paymentStatus,
          )
            ? date(index + 1)
            : null,
          fulfilledAt:
            fulfillmentStatus === 'COMPLETED' ? date(index + 1) : null,
          cancelledAt:
            fulfillmentStatus === 'CANCELLED' ? date(index + 1) : null,
          cancellationReason:
            fulfillmentStatus === 'CANCELLED'
              ? 'Admin-only cancellation explanation'
              : null,
          paymentRecordedAt: legacy ? date(4) : null,
          // Two Alice rows share a timestamp to exercise stable pagination ties.
          createdAt: date(index === 8 ? 7 : index + 1),
        },
      }),
    )
    if (legacy) legacyId = orders.at(-1)!.id
  }
  const subscription = await db.subscription.create({
    data: {
      userId: alice.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Frozen Alpha',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 12900,
      termSnapshot: 'Frozen calendar month',
      formSchemaSnapshot: schema,
      formData: { account: 'alice-original-account' },
      startedAt: date(1),
      expiresAt: date(31),
      renewalPriceFen: 9900,
    },
  })
  const hidden = await db.order.create({
    data: {
      orderNo: 'READ-HIDDEN',
      userId: alice.id,
      productId,
      subscriptionId: subscription.id,
      source: 'SYSTEM_RENEWAL',
      kind: 'RENEWAL',
      hidden: true,
      productNameSnapshot: 'Hidden renewal product',
      productTypeSnapshot: 'SUBSCRIPTION',
      termSnapshot: 'one month',
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      amountFen: 9900,
      contactEmailSnapshot: alice.loginEmail,
      paymentStatus: 'PAID',
      fulfillmentStatus: 'COMPLETED',
      paidAt: date(10),
      paymentConfirmedAt: date(10),
      fulfilledAt: date(10),
      renewalForPeriodStartAt: date(1),
      renewalPeriodStartAt: date(31),
      renewalPeriodEndAt: new Date('2028-02-29T00:00:00.000Z'),
      billingAnchorSnapshotAt: date(1),
      billingTimezoneSnapshot: 'Asia/Shanghai',
      billingRevisionSnapshot: 1,
      renewalRequestKeyHash: randomBytes(32).toString('hex'),
      renewalRequestHash: randomBytes(32).toString('hex'),
    },
  })
  hiddenId = hidden.id
  await db.paymentTransaction.create({
    data: {
      orderId: orders[1].id,
      kind: 'PAYMENT',
      channel: 'OTHER',
      amountFen: orders[1].amountFen,
      status: 'CONFIRMED',
      occurredAt: date(2),
      confirmedAt: date(2),
      createdByAdminId: admin.id,
      confirmedByAdminId: admin.id,
      externalReference: 'PRIVATE_PAYMENT_REFERENCE',
      note: 'PRIVATE_PAYMENT_NOTE',
    },
  })
  await db.orderEvent.create({
    data: {
      orderId: orders[0].id,
      eventType: 'NOTE',
      actorAdminId: admin.id,
      note: 'PRIVATE_EVENT_NOTE',
      toStateJson: { internal: 'PRIVATE_EVENT_METADATA' },
    },
  })
  await db.adminAuditLog.create({
    data: {
      actorAdminId: admin.id,
      action: 'ORDER_READ_TEST_FIXTURE',
      entityType: 'Order',
      entityId: orders[0].id,
      requestId: randomUUID(),
      afterJson: { private: 'PRIVATE_AUDIT_METADATA' },
    },
  })
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
      server.close((error) => (error ? reject(error) : resolve())),
    )
  await db.$disconnect()
})

test('all four routes require a live Session and the correct ADMIN/CUSTOMER role', async () => {
  for (const [prefix, wrongRole] of [
    ['/admin', cookies.alice],
    ['/customer', cookies.admin],
  ]) {
    for (const suffix of ['/orders', '/orders/' + orders[0].id]) {
      for (const cookie of [
        '',
        COOKIE_NAME + '=invalid',
        cookies.expired,
        cookies.revoked,
        cookies.disabled,
      ])
        assert.equal((await request(prefix + suffix, cookie)).status, 401)
      assert.equal((await request(prefix + suffix, wrongRole)).status, 403)
    }
  }
})

test('ADMIN reads both USER/ADMIN ordinary orders, including pending customers; hidden renewals never appear', async () => {
  const result = await request('/admin/orders?pageSize=100')
  assert.equal(result.status, 200)
  assert.equal(result.body.total, orders.length)
  assert.deepEqual(
    new Set(
      result.body.items.map(
        (o: { creator: { source: string } }) => o.creator.source,
      ),
    ),
    new Set(['ADMIN', 'USER']),
  )
  assert(
    result.body.items.some(
      (o: { customer: { id: string } }) => o.customer.id === pending.id,
    ),
  )
  for (const order of orders) {
    const detail = await request('/admin/orders/' + order.id)
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.order.creator, {
      source: order.source,
      adminId: order.createdByAdminId,
      userId: order.createdByUserId,
    })
  }
  assert.equal(
    (await request('/admin/orders?search=READ-HIDDEN')).body.total,
    0,
  )
  assert.equal((await request('/admin/orders?kind=RENEWAL')).body.total, 0)
  assert.equal((await request('/admin/orders/' + hiddenId)).status, 404)
})

test('CUSTOMER list and detail enforce ownership in both directions and conceal missing/foreign/hidden orders identically', async () => {
  for (const [user, cookie, other] of [
    [alice, cookies.alice, bob],
    [bob, cookies.bob, alice],
  ] as const) {
    const result = await request('/customer/orders?pageSize=100', cookie)
    const expected = orders.filter((o) => o.userId === user.id)
    assert.equal(result.status, 200)
    assert.equal(result.body.total, expected.length)
    assert.deepEqual(
      new Set(result.body.items.map((o: { id: string }) => o.id)),
      new Set(expected.map((o) => o.id)),
    )
    for (const order of expected)
      assert.equal(
        (await request('/customer/orders/' + order.id, cookie)).status,
        200,
      )
    const errors = []
    for (const id of [
      orders.find((o) => o.userId === other.id)!.id,
      hiddenId,
      randomUUID(),
    ]) {
      const result = await request('/customer/orders/' + id, cookie)
      assert.equal(result.status, 404)
      errors.push([result.body.error.code, result.body.error.message])
      const qr = await request('/customer/orders/' + id + '/wechat-qr', cookie)
      assert.equal(qr.status, 404)
      assert.deepEqual(
        [qr.body.error.code, qr.body.error.message],
        errors.at(-1),
      )
      const claim = await fetch(
        base + '/api/v1/customer/orders/' + id + '/payment-claim',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: env.APP_BASE_URL,
            'X-Requested-With': 'MembershipStore',
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ expectedVersion: 1 }),
        },
      )
      assert.equal(claim.status, 404)
      const claimBody = await claim.json()
      assert.deepEqual(
        [claimBody.error.code, claimBody.error.message],
        errors.at(-1),
      )
    }
    assert.deepEqual(errors[0], errors[1])
    assert.deepEqual(errors[1], errors[2])
    assert.equal(
      (await request('/customer/orders?search=' + other.loginEmail, cookie))
        .body.total,
      0,
    )
  }
  assert.equal((await request('/admin/orders/' + randomUUID())).status, 404)
})

test('query schemas reject userId, hidden and other overrides on list AND detail; IDs and filters are validated', async () => {
  for (const suffix of ['/orders', '/orders/' + orders[0].id]) {
    for (const query of [
      'userId=' + bob.id,
      'userId[]=' + bob.id,
      'user[id]=' + bob.id,
      'hidden=true',
      'includeHidden=true',
      'customer=PRIVATE_ALICE_LABEL',
      'source=ADMIN',
    ])
      assert.equal(
        (await request('/customer' + suffix + '?' + query, cookies.alice))
          .status,
        400,
      )
  }
  for (const query of [
    'hidden=true',
    'includeHidden=true',
    'userId=' + alice.id,
    'page=0',
    'pageSize=101',
    'page=1&page=2',
    'kind=INVALID',
    'paymentStatus=COMPLETED',
    'fulfillmentStatus=PAID',
    'sort=INVALID',
  ])
    assert.equal((await request('/admin/orders?' + query)).status, 400)
  assert.equal((await request('/admin/orders/not-an-id')).status, 400)
  assert.equal(
    (await request('/customer/orders/not-an-id', cookies.alice)).status,
    400,
  )
})

test('ADMIN searches order number, public customer names/email, private labels and frozen product names', async () => {
  assert.equal(
    (await request('/admin/orders?orderNo=READ-001')).body.items[0].id,
    orders[0].id,
  )
  for (const customer of [
    alice.loginEmail,
    alice.username!,
    alice.adminLabel!,
  ]) {
    for (const key of ['customer', 'search']) {
      const result = await request(
        '/admin/orders?' + key + '=' + encodeURIComponent(customer),
      )
      assert.equal(
        result.body.total,
        orders.filter((o) => o.userId === alice.id).length,
      )
      assert(
        result.body.items.every(
          (o: { customer: { id: string } }) => o.customer.id === alice.id,
        ),
      )
    }
  }
  const result = await request(
    '/admin/orders?productName=Frozen%20Alpha&customer=PRIVATE_ALICE_LABEL&kind=INITIAL&paymentStatus=UNPAID&fulfillmentStatus=NOT_STARTED',
  )
  assert.deepEqual(
    result.body.items.map((o: { id: string }) => o.id),
    [orders[0].id],
  )
  // A private label cannot be probed even by its own customer.
  assert.equal(
    (
      await request(
        '/customer/orders?search=PRIVATE_ALICE_LABEL',
        cookies.alice,
      )
    ).body.total,
    0,
  )
})

test('pagination, all payment/fulfillment/kind filters, and ascending/descending creation-time ordering work in both scopes', async () => {
  for (const [prefix, cookie, own] of [
    ['/admin', cookies.admin, orders],
    ['/customer', cookies.alice, orders.filter((o) => o.userId === alice.id)],
  ] as const) {
    for (const sort of ['asc', 'desc']) {
      const expected = [...own].sort(
        (a, b) =>
          (a.createdAt.getTime() - b.createdAt.getTime()) *
            (sort === 'asc' ? 1 : -1) || a.id.localeCompare(b.id),
      )
      const result = await request(
        prefix + '/orders?sort=' + sort + '&page=2&pageSize=2',
        cookie,
      )
      assert.equal(result.body.total, own.length)
      assert.equal(result.body.page, 2)
      assert.equal(result.body.pageSize, 2)
      assert.deepEqual(
        result.body.items.map((o: { id: string }) => o.id),
        expected.slice(2, 4).map((o) => o.id),
      )
      const all = await request(
        prefix + '/orders?sort=' + sort + '&pageSize=100',
        cookie,
      )
      assert.deepEqual(
        all.body.items.map((o: { id: string }) => o.id),
        expected.map((o) => o.id),
      )
    }
    assert.deepEqual(
      (await request(prefix + '/orders?page=10000', cookie)).body.items,
      [],
    )
    for (const key of ['kind', 'paymentStatus', 'fulfillmentStatus'] as const) {
      for (const value of new Set(orders.map((o) => o[key]))) {
        const result = await request(
          prefix + '/orders?' + key + '=' + value,
          cookie,
        )
        assert.equal(
          result.body.total,
          own.filter((o) => o[key] === value).length,
        )
        assert(
          result.body.items.every(
            (o: Record<string, string>) => o[key] === value,
          ),
        )
      }
    }
  }
})

test('partial order number, customer email and frozen product name match; whitespace filters equal omitted filters', async () => {
  const cases = [
    {
      keys: ['orderNo', 'search'],
      value: 'AD-00',
      matches: (order: Order) => order.orderNo.includes('AD-00'),
    },
    {
      keys: ['productName', 'search'],
      value: 'rozen Al',
      matches: (order: Order) => order.productNameSnapshot.includes('rozen Al'),
    },
    {
      keys: ['customer', 'search'],
      value: 'alice@exam',
      matches: (order: Order) => order.userId === alice.id,
    },
  ]
  for (const [prefix, cookie, own] of [
    ['/admin', cookies.admin, orders],
    ['/customer', cookies.alice, orders.filter((o) => o.userId === alice.id)],
  ] as const) {
    for (const scenario of cases) {
      if (prefix === '/customer' && scenario.keys.includes('customer')) continue
      const expected = own.filter(scenario.matches).map((o) => o.id)
      assert(expected.length > 0 && expected.length < own.length)
      for (const key of scenario.keys) {
        const query = new URLSearchParams({
          [key]: scenario.value,
          pageSize: '100',
        })
        const result = await request(prefix + '/orders?' + query, cookie)
        assert.equal(result.status, 200)
        assert.equal(result.body.total, expected.length)
        assert.deepEqual(
          new Set(result.body.items.map((o: { id: string }) => o.id)),
          new Set(expected),
        )
      }
    }
    const comparisonStarted = Date.now()
    const baseline = await request(
      prefix + '/orders?sort=asc&pageSize=100',
      cookie,
    )
    const query = new URLSearchParams({
      search: ' \t\n ',
      orderNo: ' \t ',
      productName: ' \n ',
      ...(prefix === '/admin' ? { customer: ' \t ' } : {}),
      sort: 'asc',
      pageSize: '100',
    })
    const blank = await request(prefix + '/orders?' + query, cookie)
    assert.equal(baseline.status, 200)
    assert.equal(blank.status, 200)
    assert.equal(blank.body.total, own.length)
    // Countdown is sampled on the server for each HTTP request, so wall time
    // may advance between otherwise identical queries. All static fields match.
    const stable = (body: typeof blank.body) => ({
      ...body,
      items: body.items.map((item: Record<string, unknown>) => ({
        ...item,
        remainingSeconds: 0,
      })),
    })
    assert.deepEqual(stable(blank.body), stable(baseline.body))
    for (const [index, item] of blank.body.items.entries()) {
      const previous = baseline.body.items[index].remainingSeconds
      assert(item.remainingSeconds <= previous)
      assert(
        previous - item.remainingSeconds <=
          Math.ceil((Date.now() - comparisonStarted) / 1000),
      )
    }
  }
})

test('URL punctuation, Unicode, SQL-like text and MySQL LIKE patterns preserve search semantics and customer isolation', async () => {
  const special = orders[11]
  const percentLookalike = orders[14],
    underscoreLookalike = orders[15],
    backslashLookalike = orders[16]
  assert(special.productNameSnapshot.includes(String.raw`100%_ready\path`))
  assert.equal(
    percentLookalike.productNameSnapshot,
    String.raw`100X_ready\path`,
  )
  assert.equal(
    underscoreLookalike.productNameSnapshot,
    String.raw`100%Xready\path`,
  )
  assert.equal(backslashLookalike.productNameSnapshot, '100%_readypath')
  for (const order of [
    special,
    percentLookalike,
    underscoreLookalike,
    backslashLookalike,
  ])
    assert.equal(order.userId, alice.id)
  const literalCases = [
    // Only the target matches when all three characters are escaped literally.
    [String.raw`100\%\_ready\\path`, [special]],
    // Positive controls: removing one escape exposes that specific distractor.
    [String.raw`100%\_ready\\path`, [special, percentLookalike]],
    [String.raw`100\%_ready\\path`, [special, underscoreLookalike]],
    [String.raw`100\%\_ready\path`, [backslashLookalike]],
  ] as const
  for (const [prefix, cookie, own] of [
    ['/admin', cookies.admin, orders],
    ['/customer', cookies.alice, orders.filter((o) => o.userId === alice.id)],
    ['/customer', cookies.bob, orders.filter((o) => o.userId === bob.id)],
  ] as const) {
    for (const key of ['search', 'productName']) {
      for (const [value, matching] of literalCases) {
        const expected = own.filter((o) =>
          matching.some((match) => match.id === o.id),
        )
        const query = new URLSearchParams({ [key]: value, pageSize: '100' })
        const result = await request(prefix + '/orders?' + query, cookie)
        assert.equal(result.status, 200)
        assert.equal(result.body.total, expected.length)
        assert.equal(result.body.items.length, expected.length)
        assert.deepEqual(
          result.body.items.map((o: { id: string }) => o.id).sort(),
          expected.map((o) => o.id).sort(),
          `${prefix} ${key} must preserve LIKE escapes: ${value}`,
        )
      }
      for (const value of [
        'O\'Reilly + C++ & /?# "quoted"',
        '中文',
        "' OR 1=1 --",
        '%',
        '_',
      ]) {
        const expected = ['%', '_'].includes(value)
          ? own
          : value === "' OR 1=1 --"
            ? []
            : own.filter((o) => o.id === special.id)
        const query = new URLSearchParams({ [key]: value, pageSize: '100' })
        const result = await request(prefix + '/orders?' + query, cookie)
        assert.equal(result.status, 200)
        assert.equal(result.body.total, expected.length)
        assert.deepEqual(
          new Set(result.body.items.map((o: { id: string }) => o.id)),
          new Set(expected.map((o) => o.id)),
        )
      }
    }
  }
})

test('CUSTOMER search plus payment, fulfillment and pagination returns only its own matching orders on every page', async () => {
  const matchesStatuses = (order: Order) =>
    order.paymentStatus === 'PAID' && order.fulfillmentStatus === 'PROCESSING'
  const matches = (order: Order) =>
    order.productNameSnapshot.includes('rozen') && matchesStatuses(order)
  for (const [user, cookie] of [
    [alice, cookies.alice],
    [bob, cookies.bob],
  ] as const) {
    const expected = orders
      .filter((o) => o.userId === user.id && matches(o))
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )
    assert(expected.length > 0)
    assert(orders.some((o) => o.userId !== user.id && matches(o)))
    const statusOnly = orders.filter(
      (o) => o.userId === user.id && matchesStatuses(o),
    )
    const excluded = statusOnly.filter((o) => !matches(o))
    assert(
      excluded.length > 0,
      'Each customer must own a status-matching search distractor',
    )
    assert(statusOnly.length > expected.length)
    // The control HTTP request proves the same-owner distractors satisfy every other filter.
    const controlQuery = new URLSearchParams({
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PROCESSING',
      pageSize: '100',
      sort: 'desc',
    })
    const control = await request('/customer/orders?' + controlQuery, cookie)
    assert.equal(control.status, 200)
    assert.equal(control.body.total, statusOnly.length)
    assert.deepEqual(
      control.body.items.map((o: { id: string }) => o.id).sort(),
      statusOnly.map((o) => o.id).sort(),
    )
    const seen = []
    for (let page = 1; page <= expected.length + 1; page++) {
      const query = new URLSearchParams({
        search: 'rozen',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
        page: String(page),
        pageSize: '1',
        sort: 'desc',
      })
      const result = await request('/customer/orders?' + query, cookie)
      assert.equal(result.status, 200)
      assert.equal(result.body.total, expected.length)
      assert.equal(result.body.page, page)
      assert.equal(result.body.pageSize, 1)
      const ids = result.body.items.map((o: { id: string }) => o.id)
      assert(!ids.some((id: string) => excluded.some((o) => o.id === id)))
      assert.deepEqual(
        ids,
        expected.slice(page - 1, page).map((o) => o.id),
      )
      for (const order of result.body.items) {
        assert.equal(order.paymentStatus, 'PAID')
        assert.equal(order.fulfillmentStatus, 'PROCESSING')
        assert.equal(orders.find((o) => o.id === order.id)?.userId, user.id)
      }
      seen.push(...ids)
    }
    assert.deepEqual(
      seen,
      expected.map((o) => o.id),
    )
  }
})

test('DTOs retain frozen product/period/schema/data and real timestamps after product changes/archive; unknown history stays NULL', async () => {
  await db.product.update({
    where: { id: productId },
    data: {
      name: 'CURRENT_PRODUCT_MUST_NOT_LEAK',
      description: 'CURRENT_DESCRIPTION',
      priceFen: 77777,
      renewalPriceFen: 55555,
      termLabel: 'CURRENT_TERM',
      servicePeriodUnit: 'YEAR',
      servicePeriodCount: 3,
      formSchema: { version: 1, fields: [] },
      listed: false,
      archivedAt: new Date(),
    },
  })
  for (const [prefix, cookie] of [
    ['/admin', cookies.admin],
    ['/customer', cookies.alice],
  ]) {
    const result = await request(prefix + '/orders/' + orders[0].id, cookie)
    const order = result.body.order
    assert.equal(order.productNameSnapshot, 'Frozen Alpha')
    assert.equal(
      order.productDescriptionSnapshot,
      'Frozen original description',
    )
    assert.equal(order.priceSnapshotFen, 12900)
    assert.equal(order.amountFen, 12800)
    assert.equal(order.termSnapshot, 'Frozen calendar month')
    assert.equal(order.servicePeriodUnitSnapshot, 'MONTH')
    assert.equal(order.servicePeriodCountSnapshot, 1)
    assert.deepEqual(
      order.formSchemaSnapshot,
      prefix === '/admin'
        ? schema
        : {
            version: 1,
            fields: [
              {
                id: 'account',
                type: 'text',
                label: 'Original account label',
                required: true,
                hint: '',
              },
            ],
          },
    )
    assert.deepEqual(order.formData, { account: 'alice-original-account' })
    assert.equal(order.paidAt, null)
    assert.equal(
      (
        await request(
          prefix + '/orders?productName=CURRENT_PRODUCT_MUST_NOT_LEAK',
          cookie,
        )
      ).body.total,
      0,
    )
    const legacy = (await request(prefix + '/orders/' + legacyId, cookie)).body
      .order
    for (const key of [
      'priceSnapshotFen',
      'servicePeriodUnitSnapshot',
      'servicePeriodCountSnapshot',
      'formSchemaSnapshot',
      'formData',
      'paidAt',
    ])
      assert.equal(legacy[key], null)
    assert.equal(legacy.cancelledAt, date(4).toISOString())
    const paid = (await request(prefix + '/orders/' + orders[1].id, cookie))
      .body.order
    assert.equal(paid.paidAt, date(2).toISOString())
    assert.equal(paid.paymentConfirmedAt, date(2).toISOString())
  }
})

test('ADMIN and CUSTOMER list/detail DTOs match independent complete key allowlists, including nested customer and creator', async () => {
  // Keep the contract independent of production selects/DTOs: extra keys must fail.
  const customerKeys = [
    'version',
    'expiresAt',
    'remainingSeconds',
    'id',
    'orderNo',
    'productId',
    'kind',
    'productNameSnapshot',
    'productDescriptionSnapshot',
    'productTypeSnapshot',
    'priceSnapshotFen',
    'termSnapshot',
    'servicePeriodUnitSnapshot',
    'servicePeriodCountSnapshot',
    'formSchemaSnapshot',
    'formData',
    'amountFen',
    'renewalPriceSnapshotFen',
    'contactEmailSnapshot',
    'targetIdentifier',
    'paymentStatus',
    'fulfillmentStatus',
    'createdAt',
    'paidAt',
    'paymentConfirmedAt',
    'fulfilledAt',
    'cancelledAt',
  ]
  const adminOnlyKeys = [
    'customer',
    'creator',
    'cancellationReason',
    'internalNote',
  ]
  const adminKeys = [...customerKeys, ...adminOnlyKeys]
  function assertKeys(value: unknown, expected: string[]) {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value))
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort())
  }
  for (const [prefix, cookie, own] of [
    ['/admin', cookies.admin, orders],
    ['/customer', cookies.alice, orders.filter((o) => o.userId === alice.id)],
    ['/customer', cookies.bob, orders.filter((o) => o.userId === bob.id)],
  ] as const) {
    const list = await request(prefix + '/orders?pageSize=100', cookie)
    assert.equal(list.status, 200)
    assert.equal(list.body.items.length, own.length)
    const dtos = [...list.body.items]
    for (const order of own) {
      const detail = await request(prefix + '/orders/' + order.id, cookie)
      assert.equal(detail.status, 200)
      assertKeys(detail.body, ['order'])
      if (prefix === '/admin') {
        assertKeys(detail.body.order, [...adminKeys, 'linkedSubscription'])
        const { linkedSubscription, ...baseDto } = detail.body.order
        assert.equal(linkedSubscription, null)
        dtos.push(baseDto)
      } else dtos.push(detail.body.order)
    }
    for (const order of dtos) {
      assertKeys(order, prefix === '/admin' ? adminKeys : customerKeys)
      if (prefix === '/admin') {
        assertKeys(order.customer, [
          'id',
          'username',
          'loginEmail',
          'notificationEmail',
        ])
        assertKeys(order.creator, ['source', 'adminId', 'userId'])
        assert.equal(
          order.internalNote,
          orders.find((row) => row.id === order.id)!.internalNote,
        )
      } else {
        for (const key of adminOnlyKeys) assert(!Object.hasOwn(order, key))
      }
    }
  }
})

test('DTOs exclude authentication, audit, payment references and private labels; only ADMIN receives internalNote', async () => {
  for (const [prefix, cookie] of [
    ['/admin', cookies.admin],
    ['/customer', cookies.alice],
  ]) {
    for (const suffix of [
      '/orders?pageSize=100',
      '/orders/' + orders[0].id,
      '/orders/' + orders[1].id,
    ]) {
      const result = await request(prefix + suffix, cookie)
      const text = JSON.stringify(result.body)
      for (const banned of [
        'passwordHash',
        'tokenHash',
        'membership_session',
        'adminLabel',
        'beforeJson',
        'afterJson',
        'requestId',
        'renewalRequestKeyHash',
        'renewalRequestHash',
        'paymentRecordedAt',
        'PRIVATE_ALICE_LABEL',
        'PRIVATE_EVENT_',
        'PRIVATE_AUDIT_',
        'PRIVATE_PAYMENT_',
        'synthetic-not-a-login-hash',
      ])
        assert(!text.includes(banned), 'DTO exposed forbidden data: ' + banned)
      assert.equal(result.headers.get('cache-control'), 'no-store')
      assert(result.headers.get('x-request-id'))
      if (prefix === '/customer') {
        assert(!text.includes('internalNote'))
        assert(!text.includes('PRIVATE_ORDER_NOTE'))
        for (const other of [
          bob.id,
          bob.loginEmail,
          pending.id,
          pending.loginEmail,
          admin.id,
          'creator',
          'customer',
          'cancellationReason',
        ])
          assert(
            !text.includes(other),
            'Customer DTO exposed another identity or internal field.',
          )
      }
    }
  }
})

test('HTTP DTO deadlines come from original createdAt and server time; payment/cancellation/completion stop countdown; edits preserve deadline', async () => {
  const createdAt = new Date(Date.now() - 3600000)
  const active = await db.order.create({
    data: {
      orderNo: randomUUID(),
      userId: alice.id,
      productId,
      source: 'USER',
      createdByUserId: alice.id,
      kind: 'ONE_TIME',
      productNameSnapshot: 'Countdown fixture',
      productTypeSnapshot: 'ONE_TIME',
      termSnapshot: 'Display only',
      amountFen: 100,
      contactEmailSnapshot: alice.loginEmail,
      createdAt,
    },
  })
  const expired = await db.order.create({
    data: {
      orderNo: randomUUID(),
      userId: alice.id,
      productId,
      source: 'USER',
      createdByUserId: alice.id,
      kind: 'ONE_TIME',
      productNameSnapshot: 'Expired fixture',
      productTypeSnapshot: 'ONE_TIME',
      termSnapshot: 'Display only',
      amountFen: 100,
      contactEmailSnapshot: alice.loginEmail,
      createdAt: new Date(Date.now() - 86401000),
    },
  })
  await db.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: active.id, version: 1 },
      data: {
        internalNote: 'Admin-only later note',
        version: { increment: 1 },
      },
    })
    await tx.orderRevision.create({
      data: {
        orderId: updated.id,
        version: 2,
        snapshotSchemaVersion: 1,
        snapshotJson: buildOrderSnapshot(updated),
        actorUserId: admin.id,
        actorType: 'ADMIN',
      },
    })
  })
  for (const [prefix, cookie] of [
    ['/admin', cookies.admin],
    ['/customer', cookies.alice],
  ]) {
    const start = Date.now()
    const current = (await request(prefix + '/orders/' + active.id, cookie))
      .body.order
    const end = Date.now()
    const deadline = createdAt.getTime() + 86400000
    assert.equal(current.expiresAt, new Date(deadline).toISOString())
    assert.equal(current.version, 2)
    assert(current.remainingSeconds >= Math.floor((deadline - end) / 1000))
    assert(current.remainingSeconds <= Math.floor((deadline - start) / 1000))
    assert.equal(Object.hasOwn(current, 'internalNote'), prefix === '/admin')
    if (prefix === '/admin')
      assert.equal(current.internalNote, 'Admin-only later note')
    for (const row of [expired, orders[1], orders[3], orders[8]]) {
      const result = (await request(prefix + '/orders/' + row.id, cookie)).body
        .order
      assert.equal(result.remainingSeconds, 0)
      assert.equal(
        result.expiresAt,
        new Date(row.createdAt.getTime() + 86400000).toISOString(),
      )
    }
    const listing = await request(
      prefix + '/orders?search=Countdown%20fixture',
      cookie,
    )
    assert.equal(listing.body.total, 1)
    assert.equal(listing.body.items[0].version, 2)
    assert.equal(listing.body.items[0].expiresAt, current.expiresAt)
  }
})

test('GET queries write no business records; deletion and fulfillment remain unavailable', async () => {
  const before = {
    ...(await businessSnapshot(db)),
    revisions: await db.orderRevision.findMany(),
  }
  for (const [prefix, cookie] of [
    ['/admin', cookies.admin],
    ['/customer', cookies.alice],
  ]) {
    assert.equal((await request(prefix + '/orders', cookie)).status, 200)
    assert.equal(
      (await request(prefix + '/orders/' + orders[0].id, cookie)).status,
      200,
    )
    for (const [suffix, method] of [
      ['/orders/' + orders[0].id, 'DELETE'],
      ['/orders/' + orders[0].id + '/complete', 'POST'],
    ])
      assert.equal((await request(prefix + suffix, cookie, method)).status, 404)
  }
  assert(
    isDeepStrictEqual(
      {
        ...(await businessSnapshot(db)),
        revisions: await db.orderRevision.findMany(),
      },
      before,
    ),
    'Read API or absent mutation path changed persisted records.',
  )
})
