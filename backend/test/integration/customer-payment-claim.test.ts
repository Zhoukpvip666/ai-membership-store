import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { rename } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import type { Order, Prisma } from '../../src/generated/prisma/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { orderTimeoutService } from '../../src/modules/orders/timeout.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let server: Server
let base: string
let adminId: string
let ownerId: string
let productId: string
let admin: string
let owner: string
let stranger: string
let pending: string
const qrPath = '/admin/settings/wechat-qr'
const settingsPath = '/admin/settings/wechat-payment'
const root = (order: Order) => '/customer/orders/' + order.id

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

before(async () => {
  const customer = (status: 'ACTIVE' | 'PENDING_ACTIVATION' = 'ACTIVE') =>
    db.user.create({
      data: { status, loginEmail: randomUUID() + '@example.com' },
    })
  const [administrator, ownAccount, otherAccount, pendingAccount, product] =
    await Promise.all([
      db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
      customer(),
      customer(),
      customer('PENDING_ACTIVATION'),
      db.product.create({
        data: {
          slug: randomUUID(),
          name: 'Claim test',
          type: 'SUBSCRIPTION',
          priceFen: 1234,
          termLabel: 'Monthly',
          renewalPriceFen: 1234,
          servicePeriodUnit: 'MONTH',
          servicePeriodCount: 1,
        },
      }),
    ])
  adminId = administrator.id
  ownerId = ownAccount.id
  productId = product.id
  admin = await session(adminId)
  owner = await session(ownerId)
  stranger = await session(otherAccount.id)
  pending = await session(pendingAccount.id)
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  base =
    'http://127.0.0.1:' +
    (server.address() as { port: number }).port +
    '/api/v1'
})

after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
})

function fixture(data: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return db.order.create({
    data: {
      orderNo: 'CLAIM-' + randomUUID().slice(0, 16),
      userId: ownerId,
      productId,
      source: 'ADMIN',
      kind: 'INITIAL',
      createdByAdminId: adminId,
      amountFen: 1234,
      productNameSnapshot: 'Frozen claim test',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1234,
      termSnapshot: 'Monthly',
      contactEmailSnapshot: 'customer@example.com',
      renewalPriceSnapshotFen: 1234,
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      createdAt: new Date(Date.now() - 120000),
      ...data,
    },
  })
}

function request(
  path: string,
  cookie = owner,
  method = 'GET',
  body?: object,
  key: string = randomUUID(),
  csrf = true,
) {
  const binary = Buffer.isBuffer(body)
  return fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      'Idempotency-Key': key,
      ...(body
        ? {
            'Content-Type': binary
              ? 'application/octet-stream'
              : 'application/json',
          }
        : {}),
      ...(csrf
        ? { Origin: env.APP_BASE_URL, 'X-Requested-With': 'MembershipStore' }
        : {}),
    },
    body: binary
      ? new Uint8Array(body)
      : body
        ? JSON.stringify(body)
        : undefined,
  })
}
const claim = (order: Order, version = 1, key?: string) =>
  request(
    root(order) + '/payment-claim',
    owner,
    'POST',
    { expectedVersion: version },
    key,
  )
const image = (order: Order, cookie = owner) =>
  request(root(order) + '/wechat-qr', cookie)
const stored = (order: Order) =>
  db.order.findUniqueOrThrow({ where: { id: order.id } })

test('image and claim require an ACTIVE storefront session and conceal other or missing orders', async () => {
  const order = await fixture()
  for (const [cookie, status] of [
    ['', 401],
    [admin, 404],
    [pending, 401],
    [stranger, 404],
  ] as const) {
    assert.equal((await image(order, cookie)).status, status)
    assert.equal(
      (
        await request(root(order) + '/payment-claim', cookie, 'POST', {
          expectedVersion: 1,
        })
      ).status,
      status,
    )
  }
  for (const path of ['/wechat-qr', '/payment-claim']) {
    const missing = await request(
      '/customer/orders/' + randomUUID() + path,
      owner,
      path === '/wechat-qr' ? 'GET' : 'POST',
      path === '/wechat-qr' ? undefined : { expectedVersion: 1 },
    )
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'NOT_FOUND')
  }
  assert.equal(
    (
      await request(
        root(order) + '/payment-claim',
        owner,
        'POST',
        { expectedVersion: 1 },
        undefined,
        false,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await request(root(order) + '/payment-claim', owner, 'POST', {
        expectedVersion: 1,
        amountFen: 1234,
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await request(
        root(order) + '/payment-claim',
        owner,
        'POST',
        { expectedVersion: 1 },
        '',
      )
    ).status,
    400,
  )
  assert.equal(
    (await request(root(order) + '/wechat-qr?file=../test.env')).status,
    400,
  )
  assert.deepEqual(await stored(order), order)
})

test('QR requires enabled, readable settings and a payable order; approved bytes are no-store PNG', async () => {
  const order = await fixture()
  assert.equal((await image(order)).status, 404)
  const png = await sharp({
    create: { width: 72, height: 72, channels: 3, background: '#004455' },
  })
    .png()
    .toBuffer()
  assert.equal((await request(qrPath, admin, 'PUT', png)).status, 200)
  assert.equal((await image(order)).status, 404)
  assert.equal(
    (await request(settingsPath, admin, 'PATCH', { enabled: true })).status,
    200,
  )
  const response = await image(order)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(
    (await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width,
    72,
  )

  const settings = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  const directory = env.WECHAT_QR_STORAGE_DIR
  assert(directory && settings.wechatQrImageKey)
  const path = join(directory, settings.wechatQrImageKey)
  await rename(path, path + '.test-missing')
  try {
    assert.equal((await image(order)).status, 503)
    assert.equal((await claim(order)).status, 200)
  } finally {
    await rename(path + '.test-missing', path)
  }
  assert.equal((await image(order)).status, 404)
  for (const data of [
    {
      paymentStatus: 'NOT_REQUIRED',
      amountFen: 0,
      fulfillmentStatus: 'PROCESSING',
    },
    { paymentStatus: 'PAID', fulfillmentStatus: 'PROCESSING' },
    { paymentStatus: 'PAID', fulfillmentStatus: 'COMPLETED' },
    { fulfillmentStatus: 'CANCELLED', cancelledAt: new Date() },
    { createdAt: new Date(Date.now() - 86_401_000) },
  ] as const) {
    const ineligible = await fixture(data)
    assert.equal((await image(ineligible)).status, 404)
    assert.equal((await claim(ineligible)).status, 409)
  }
  assert.equal(
    (await request(settingsPath, admin, 'PATCH', { enabled: false })).status,
    200,
  )
})

test('concurrent claims replay one revision and event with no payment or fulfillment facts even when disabled', async () => {
  const order = await fixture()
  const key = randomUUID()
  const responses = await Promise.all([
    claim(order, 1, key),
    claim(order, 1, key),
  ])
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  )
  const [first, second] = await Promise.all(responses.map((r) => r.json()))
  assert.deepEqual(first, second)
  assert.equal(first.order.version, 2)
  assert.equal(first.order.paymentStatus, 'PENDING_VERIFICATION')
  assert.equal(first.order.fulfillmentStatus, 'NOT_STARTED')
  assert.equal(first.order.paidAt, null)
  assert.equal(first.order.paymentConfirmedAt, null)
  assert.equal(first.order.fulfilledAt, null)
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
    0,
  )
  assert.equal(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
    0,
  )
  const revisions = await db.orderRevision.findMany({
    where: { orderId: order.id },
  })
  assert.equal(revisions.length, 1)
  assert.equal(revisions[0].actorType, 'USER')
  assert.equal(revisions[0].actorUserId, ownerId)
  assert.equal(revisions[0].version, 2)
  const events = await db.orderEvent.findMany({ where: { orderId: order.id } })
  assert.equal(events.length, 1)
  assert.equal(events[0].actorType, 'USER')
  assert.equal(events[0].actorUserId, ownerId)
  assert.deepEqual(events[0].fromStateJson, {
    operation: 'CUSTOMER_PAYMENT_CLAIMED',
    paymentStatus: 'UNPAID',
    fulfillmentStatus: 'NOT_STARTED',
    version: 1,
  })
  assert.deepEqual(events[0].toStateJson, {
    operation: 'CUSTOMER_PAYMENT_CLAIMED',
    paymentStatus: 'PENDING_VERIFICATION',
    fulfillmentStatus: 'NOT_STARTED',
    version: 2,
  })
  assert.equal(
    (await (await claim(order)).json()).error.code,
    'VERSION_CONFLICT',
  )
  assert.equal(
    (await (await claim(order, 2)).json()).error.code,
    'ORDER_NOT_PAYABLE',
  )
  assert.equal(
    (await (await claim(order, 2, key)).json()).error.code,
    'IDEMPOTENCY_CONFLICT',
  )
})

test('claim versus cancel has one winner at the same version, and timeouts still cancel unverified claims', async () => {
  const order = await fixture()
  const [claimed, cancelled] = await Promise.all([
    claim(order),
    request(root(order) + '/cancel', owner, 'POST', { expectedVersion: 1 }),
  ])
  assert.deepEqual([claimed.status, cancelled.status].sort(), [200, 409])
  assert.equal((await stored(order)).version, 2)
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  const expiredAt = new Date(Date.now() - 86_401_000)
  const expired = await fixture({ createdAt: expiredAt })
  const unverified = await fixture({
    createdAt: expiredAt,
    paymentStatus: 'PENDING_VERIFICATION',
  })
  const [late, sweep] = await Promise.all([
    claim(expired),
    orderTimeoutService(db)(),
  ])
  assert.equal(late.status, 409)
  assert.equal(sweep.failed, 0)
  for (const item of [expired, unverified]) {
    const latest = await stored(item)
    assert.equal(latest.fulfillmentStatus, 'CANCELLED')
    assert.equal(latest.paymentStatus, 'UNPAID')
    assert.equal(
      await db.paymentTransaction.count({ where: { orderId: item.id } }),
      0,
    )
  }
})

test('ADMIN finds the unverified claim and must record and confirm a real receipt before fulfillment', async () => {
  const order = await fixture()
  assert.equal((await claim(order)).status, 200)
  const list = await (
    await request('/admin/orders?paymentStatus=PENDING_VERIFICATION', admin)
  ).json()
  assert(list.items.some((entry: { id: string }) => entry.id === order.id))
  const timeline = await (
    await request('/admin/orders/' + order.id + '/events', admin)
  ).json()
  assert.equal(timeline.items[0].operation, 'CUSTOMER_PAYMENT_CLAIMED')
  assert.equal(
    Object.hasOwn(timeline.items[0].summary, 'transactionKind'),
    false,
  )
  assert.equal(
    (
      await request('/admin/orders/' + order.id + '/fulfill', admin, 'POST', {
        expectedVersion: 2,
      })
    ).status,
    409,
  )
  const record = await request(
    '/admin/orders/' + order.id + '/payment-transactions',
    admin,
    'POST',
    {
      expectedVersion: 2,
      amountFen: 1234,
      channel: 'WECHAT',
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    },
  )
  assert.equal(record.status, 201)
  const { paymentTransaction } = await record.json()
  assert.equal(paymentTransaction.status, 'PENDING')
  assert.equal((await stored(order)).paymentStatus, 'PENDING_VERIFICATION')
  assert.equal((await stored(order)).paidAt, null)
  const confirm = await request(
    '/admin/payment-transactions/' + paymentTransaction.id + '/confirm',
    admin,
    'POST',
    { expectedVersion: 3 },
  )
  assert.equal(confirm.status, 200)
  const { order: paid } = await confirm.json()
  assert.equal(paid.paymentStatus, 'PAID')
  assert.equal(paid.fulfillmentStatus, 'PROCESSING')
  assert(paid.paidAt && paid.paymentConfirmedAt)
  assert.equal(paid.fulfilledAt, null)
  assert.equal(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
    0,
  )
})
