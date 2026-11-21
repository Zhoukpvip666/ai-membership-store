import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const path = '/customer/subscriptions'
let server: Server | undefined, base: string
let owner: string, stranger: string, admin: string
let ownerCookie: string, strangerCookie: string, adminCookie: string
let order: { id: string; orderNo: string },
  fulfilledId: string,
  expiredId: string,
  terminatedId: string

async function session(userId: string) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  return COOKIE_NAME + '=' + token
}

async function request(url: string, cookie?: string, data?: unknown) {
  const response = await fetch(base + '/api/v1' + url, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined
        ? {}
        : {
            Origin: env.APP_BASE_URL,
            'Content-Type': 'application/json',
            'X-Requested-With': 'MembershipStore',
            'Idempotency-Key': randomUUID(),
          }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  return { status: response.status, body: await response.json() }
}

before(async () => {
  admin = (await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id
  owner = (
    await db.user.create({
      data: { loginEmail: randomUUID() + '@example.test', status: 'ACTIVE' },
    })
  ).id
  stranger = (
    await db.user.create({
      data: {
        loginEmail: randomUUID() + '@example.test',
        status: 'ACTIVE',
        adminLabel: 'PRIVATE_OTHER_LABEL',
      },
    })
  ).id
  ;[ownerCookie, strangerCookie, adminCookie] = await Promise.all([
    session(owner),
    session(stranger),
    session(admin),
  ])
  const item = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Frozen entitlement',
      type: 'SUBSCRIPTION',
      priceFen: 0,
      renewalPriceFen: 8800,
      termLabel: 'One month',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      formSchema: {
        version: 1,
        fields: [
          { id: 'reference', type: 'text', label: 'Reference', required: true },
        ],
      },
    },
  })
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const created = await request('/admin/orders', adminCookie, {
    userId: owner,
    productId: item.id,
    amountFen: 0,
    formData: { reference: 'PRIVATE_FORM_VALUE' },
    internalNote: 'PRIVATE_ORDER_NOTE',
  })
  assert.equal(created.status, 201)
  order = created.body.order
  const completed = await request(
    '/admin/orders/' + order.id + '/fulfill',
    adminCookie,
    { expectedVersion: 1 },
  )
  assert.equal(completed.status, 200)
  fulfilledId = completed.body.subscription.id
  await db.product.update({
    where: { id: item.id },
    data: {
      name: 'Changed live product',
      renewalPriceFen: 12000,
      archivedAt: new Date(),
      listed: false,
    },
  })

  const past = new Date(Date.now() - 86400000)
  const historical = {
    userId: owner,
    productId: item.id,
    sourceType: 'ADMIN' as const,
    createdByAdminId: admin,
    productNameSnapshot: 'Historic entitlement',
    productTypeSnapshot: 'SUBSCRIPTION' as const,
    priceSnapshotFen: 0,
    termSnapshot: 'Historic period',
    renewalPriceFen: 6500,
    startedAt: new Date(past.getTime() - 86400000),
    expiresAt: past,
    note: 'PRIVATE_SUBSCRIPTION_NOTE',
    formData: { reference: 'PRIVATE_HISTORIC_FORM' },
  }
  expiredId = (await db.subscription.create({ data: historical })).id
  terminatedId = (
    await db.subscription.create({
      data: {
        ...historical,
        status: 'TERMINATED',
        terminatedAt: past,
        terminationReason: 'PRIVATE_TERMINATION_REASON',
      },
    })
  ).id
})

after(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()))
  await db.$disconnect()
})

test('only an authenticated CUSTOMER can read subscriptions and ownership cannot be overridden', async () => {
  for (const endpoint of [path, path + '/' + fulfilledId]) {
    assert.equal((await request(endpoint)).status, 401)
    assert.equal((await request(endpoint, adminCookie)).status, 403)
    assert.equal(
      (await request(endpoint + '?userId=' + owner, strangerCookie)).status,
      400,
    )
  }
  const empty = await request(path, strangerCookie)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.items, [])
  assert.equal(empty.body.total, 0)
  const foreign = await request(path + '/' + fulfilledId, strangerCookie)
  const missing = await request(path + '/' + randomUUID(), strangerCookie)
  assert.equal(foreign.status, 404)
  assert.equal(missing.status, 404)
  assert.equal(foreign.body.error.code, 'NOT_FOUND')
  assert.equal(foreign.body.error.message, missing.body.error.message)
  assert.equal((await request(path, ownerCookie, {})).status, 404)
})

test('a fulfilled INITIAL order exposes only frozen subscription data and a safe source order to its customer', async () => {
  const list = await request(path + '?status=ACTIVE', ownerCookie)
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  const detail = await request(path + '/' + fulfilledId, ownerCookie)
  assert.equal(detail.status, 200)
  const subscription = detail.body.subscription
  assert.deepEqual(
    Object.keys(subscription).sort(),
    [
      'id',
      'productNameSnapshot',
      'termSnapshot',
      'status',
      'startedAt',
      'expiresAt',
      'renewalPriceFen',
      'sourceOrder',
    ].sort(),
  )
  assert.deepEqual(list.body.items, [subscription])
  assert.equal(subscription.id, fulfilledId)
  assert.equal(subscription.status, 'ACTIVE')
  assert.equal(subscription.productNameSnapshot, 'Frozen entitlement')
  assert.equal(subscription.renewalPriceFen, 8800)
  assert.deepEqual(subscription.sourceOrder, {
    id: order.id,
    orderNo: order.orderNo,
  })
  assert.ok(
    Date.parse(subscription.startedAt) < Date.parse(subscription.expiresAt),
  )
  assert.ok(detail.body.businessTimezone)
  assert.equal(
    (await request('/customer/orders/' + order.id, ownerCookie)).status,
    200,
  )
  assert.equal(
    (await request('/customer/orders/' + order.id, strangerCookie)).status,
    404,
  )
  assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE_/)
})

test('expiry and termination filters, paging and nullable source order are consistent and read-only', async () => {
  for (const [status, id] of [
    ['EXPIRED', expiredId],
    ['TERMINATED', terminatedId],
  ]) {
    const list = await request(path + '?status=' + status, ownerCookie)
    const detail = await request(path + '/' + id, ownerCookie)
    assert.equal(list.status, 200)
    assert.equal(detail.status, 200)
    assert.equal(list.body.total, 1)
    assert.deepEqual(list.body.items, [detail.body.subscription])
    assert.equal(detail.body.subscription.status, status)
    assert.equal(detail.body.subscription.sourceOrder, null)
    assert.doesNotMatch(JSON.stringify(detail.body), /PRIVATE_/)
  }
  const paged = await request(path + '?page=2&pageSize=1', ownerCookie)
  assert.equal(paged.status, 200)
  assert.equal(paged.body.page, 2)
  assert.equal(paged.body.pageSize, 1)
  assert.equal(paged.body.total, 3)
  assert.equal(paged.body.items.length, 1)
  assert.equal(
    (await db.subscription.findUniqueOrThrow({ where: { id: expiredId } }))
      .status,
    'ACTIVE',
  )
  assert.equal(
    (await request(path + '?status=INVALID', ownerCookie)).status,
    400,
  )
})
