import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import type { Product, User } from '../../src/generated/prisma/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let server: Server
let base: string
let admin: User
let foreign: User
let adminCookie: string
let foreignCookie: string
const orders = '/customer/orders'
const subscriptions = '/customer/subscriptions'
const adminOrders = '/admin/orders'
const wechatSettings = '/admin/settings/wechat-payment'

async function session(userId: string) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  return COOKIE_NAME + '=' + token
}

before(async () => {
  ;[admin, foreign] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { loginEmail: env.ADMIN_EMAIL } }),
    db.user.create({
      data: { loginEmail: randomUUID() + '@example.test', status: 'ACTIVE' },
    }),
  ])
  ;[adminCookie, foreignCookie] = await Promise.all([
    session(admin.id),
    session(foreign.id),
  ])
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port + '/api/v1'
})

after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
})

function request(
  path: string,
  method = 'GET',
  body?: object,
  cookie = adminCookie,
  key: string = randomUUID(),
) {
  const binary = Buffer.isBuffer(body)
  return fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      'Idempotency-Key': key,
      Origin: env.APP_BASE_URL,
      'X-Requested-With': 'MembershipStore',
      'Content-Type': binary ? 'application/octet-stream' : 'application/json',
    },
    body: binary
      ? new Uint8Array(body)
      : body
        ? JSON.stringify(body)
        : undefined,
  })
}

async function expectError(response: Response, status: number, code?: string) {
  assert.equal(response.status, status)
  if (code) assert.equal((await response.json()).error.code, code)
}

function product(type: Product['type'] = 'ONE_TIME', priceFen = 1200) {
  return db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Self-service fixture',
      type,
      priceFen,
      listed: true,
      termLabel: type === 'SUBSCRIPTION' ? 'Monthly' : 'One time',
      ...(type === 'SUBSCRIPTION'
        ? {
            renewalPriceFen: 800,
            servicePeriodUnit: 'MONTH',
            servicePeriodCount: 1,
          }
        : {}),
      formSchema: {
        version: 1,
        fields: [
          {
            id: 'target',
            type: 'text',
            label: 'Public handle',
            required: true,
          },
        ],
      },
    },
  })
}

function orderInput(item: Product) {
  return {
    productId: item.id,
    expectedProductUpdatedAt: item.updatedAt.toISOString(),
    formData: { target: 'initial-handle' },
  }
}

async function createOwn(item: Product, cookie = adminCookie) {
  const response = await request(orders, 'POST', orderInput(item), cookie)
  assert.equal(response.status, 201)
  return (await response.json()).order
}

const orderPath = (id: string) => orders + '/' + id
const adminPath = (id: string) => adminOrders + '/' + id

async function assertAdminHistory(id: string, actions: string[]) {
  const [revisions, events, audits] = await Promise.all([
    db.orderRevision.findMany({
      where: { orderId: id },
      orderBy: { version: 'asc' },
    }),
    db.orderEvent.findMany({ where: { orderId: id } }),
    db.adminAuditLog.findMany({ where: { entityType: 'Order', entityId: id } }),
  ])
  assert.equal(revisions.length, actions.length)
  assert.deepEqual(
    revisions.map((revision) => revision.version),
    actions.map((_, i) => i + 1),
  )
  assert(
    revisions.every(
      (revision) =>
        revision.actorType === 'ADMIN' && revision.actorUserId === admin.id,
    ),
  )
  assert.equal(events.length, actions.length)
  assert(
    events.every(
      (event) =>
        event.actorType === 'ADMIN' &&
        event.actorAdminId === admin.id &&
        event.actorUserId === null,
    ),
  )
  assert.deepEqual(
    audits.map((audit) => audit.action).sort(),
    [...actions].sort(),
  )
  assert(audits.every((audit) => audit.actorAdminId === admin.id))
}

test('ADMIN places a single self-service one-time order at catalog price with a customer-safe replay', async () => {
  const item = await product()
  const input = orderInput(item)
  const key = randomUUID()
  const [first, replay] = await Promise.all([
    request(orders, 'POST', input, adminCookie, key),
    request(orders, 'POST', input, adminCookie, key),
  ])
  assert.equal(first.status, 201)
  assert.equal(replay.status, 201)
  const { order } = await first.json()
  assert.deepEqual(await replay.json(), { order })
  assert.match(order.orderNo, /^[1-9][0-9]{8}$/)
  assert.equal(order.amountFen, item.priceFen)
  const row = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  assert.equal(await db.order.count({ where: { productId: item.id } }), 1)
  assert.equal(row.userId, admin.id)
  assert.equal(row.source, 'ADMIN')
  assert.equal(row.createdByAdminId, admin.id)
  assert.equal(row.createdByUserId, null)
  assert.equal(row.kind, 'ONE_TIME')
  assert.equal(row.paymentStatus, 'UNPAID')
  for (const field of [
    'creator',
    'user',
    'customer',
    'internalNote',
    'priceAdjustmentReason',
  ])
    assert.equal(Object.hasOwn(order, field), false)
  await assertAdminHistory(order.id, ['ORDER_CREATED'])
  await expectError(
    await request(
      orders,
      'POST',
      { ...input, formData: { target: 'changed' } },
      adminCookie,
      key,
    ),
    409,
    'IDEMPOTENCY_CONFLICT',
  )
})

test('ADMIN storefront retains listing, version, form and identity checks and cannot use management payloads', async () => {
  const item = await product()
  const input = orderInput(item)
  for (const body of [
    { ...input, amountFen: 1 },
    { ...input, userId: foreign.id },
    { ...input, formData: {} },
  ])
    await expectError(await request(orders, 'POST', body), 400)
  await expectError(
    await request(orders + '?userId=' + foreign.id, 'POST', input),
    400,
  )
  const updated = await db.product.update({
    where: { id: item.id },
    data: {
      listed: false,
      updatedAt: new Date(item.updatedAt.getTime() + 1000),
    },
  })
  await expectError(
    await request(orders, 'POST', input),
    409,
    'PRODUCT_CHANGED',
  )
  await expectError(
    await request(orders, 'POST', orderInput(updated)),
    409,
    'PRODUCT_NOT_AVAILABLE',
  )
  const archived = await db.product.update({
    where: { id: item.id },
    data: { archivedAt: new Date() },
  })
  await expectError(
    await request(orders, 'POST', orderInput(archived)),
    409,
    'PRODUCT_ARCHIVED',
  )
  const management = {
    productId: item.id,
    amountFen: item.priceFen,
    formData: input.formData,
    userId: admin.id,
  }
  await expectError(
    await request(adminOrders, 'POST', management),
    404,
    'CUSTOMER_NOT_FOUND',
  )
  await expectError(
    await request(
      adminOrders,
      'POST',
      { ...management, userId: foreign.id },
      foreignCookie,
    ),
    403,
  )
  for (const status of ['PENDING_ACTIVATION', 'DISABLED'] as const) {
    const inactive = await db.user.create({
      data: {
        loginEmail: randomUUID() + '@example.test',
        role: 'ADMIN',
        status,
      },
    })
    const cookie = await session(inactive.id)
    await expectError(
      await request(orders, 'POST', input, cookie),
      status === 'DISABLED' ? 401 : 403,
    )
    await expectError(
      await request(subscriptions, 'GET', undefined, cookie),
      401,
    )
  }
  await expectError(await request(orders, 'POST', input, ''), 401)
  assert.equal(await db.order.count({ where: { productId: item.id } }), 0)
})

test('ADMIN may edit and cancel only eligible personal orders, with real ADMIN history', async () => {
  const item = await product()
  const own = await createOwn(item)
  const other = await createOwn(item, foreignCookie)
  const path = orderPath(own.id)
  assert.equal((await request(path)).status, 200)
  const list = await (await request(orders + '?pageSize=100')).json()
  assert(list.items.some((order: { id: string }) => order.id === own.id))
  assert(!list.items.some((order: { id: string }) => order.id === other.id))
  for (const [suffix, method, input] of [
    ['', 'GET', undefined],
    ['', 'PATCH', { expectedVersion: 1, formData: { target: 'changed' } }],
    ['/cancel', 'POST', { expectedVersion: 1 }],
    ['/wechat-qr', 'GET', undefined],
    ['/payment-claim', 'POST', { expectedVersion: 1 }],
  ] as const)
    await expectError(
      await request(orderPath(other.id) + suffix, method, input),
      404,
      'NOT_FOUND',
    )
  assert.equal((await request(adminPath(other.id))).status, 200)
  await expectError(
    await request(adminPath(other.id), 'GET', undefined, foreignCookie),
    403,
  )
  const edit = { expectedVersion: 1, formData: { target: 'personal-edit' } }
  await expectError(
    await request(path, 'PATCH', { ...edit, amountFen: 1 }),
    400,
  )
  const editKey = randomUUID()
  const edited = await request(path, 'PATCH', edit, adminCookie, editKey)
  assert.equal(edited.status, 200)
  const editedBody = await edited.json()
  assert.equal(editedBody.order.amountFen, item.priceFen)
  assert.deepEqual(editedBody.order.formData, edit.formData)
  assert.deepEqual(
    await (await request(path, 'PATCH', edit, adminCookie, editKey)).json(),
    editedBody,
  )
  await expectError(await request(path, 'PATCH', edit), 409, 'VERSION_CONFLICT')
  const cancel = await request(path + '/cancel', 'POST', { expectedVersion: 2 })
  assert.equal(cancel.status, 200)
  const cancelled = (await cancel.json()).order
  assert.equal(cancelled.fulfillmentStatus, 'CANCELLED')
  assert.equal(Object.hasOwn(cancelled, 'internalNote'), false)
  const free = await createOwn(await product('ONE_TIME', 0))
  await expectError(
    await request(orderPath(free.id) + '/cancel', 'POST', {
      expectedVersion: 1,
    }),
    409,
    'ORDER_NOT_CANCELLABLE',
  )
  await assertAdminHistory(own.id, [
    'ORDER_CREATED',
    'ORDER_EDITED',
    'ORDER_CANCELLED',
  ])
})

test('ADMIN can scan and claim, then management fulfills the subscription for the actual owner', async () => {
  const own = await createOwn(await product('SUBSCRIPTION'))
  const foreignOrder = await createOwn(
    await product('SUBSCRIPTION', 0),
    foreignCookie,
  )
  const foreignFulfilled = await request(
    adminPath(foreignOrder.id) + '/fulfill',
    'POST',
    { expectedVersion: 1 },
  )
  assert.equal(foreignFulfilled.status, 200)
  const foreignSubscription = (await foreignFulfilled.json()).subscription
  const png = await sharp({
    create: { width: 128, height: 128, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  assert.equal(
    (await request('/admin/settings/wechat-qr', 'PUT', png)).status,
    200,
  )
  assert.equal(
    (await request(wechatSettings, 'PATCH', { enabled: true })).status,
    200,
  )
  const path = orderPath(own.id)
  const qr = await request(path + '/wechat-qr')
  assert.equal(qr.status, 200)
  assert.match(qr.headers.get('content-type') ?? '', /^image\/png/)
  assert.equal(qr.headers.get('cache-control'), 'no-store')
  const claimKey = randomUUID()
  const claim = await request(
    path + '/payment-claim',
    'POST',
    { expectedVersion: 1 },
    adminCookie,
    claimKey,
  )
  assert.equal(claim.status, 200)
  const claimed = await claim.json()
  assert.equal(claimed.order.paymentStatus, 'PENDING_VERIFICATION')
  assert.equal(claimed.order.fulfillmentStatus, 'NOT_STARTED')
  assert.deepEqual(
    await (
      await request(
        path + '/payment-claim',
        'POST',
        { expectedVersion: 1 },
        adminCookie,
        claimKey,
      )
    ).json(),
    claimed,
  )
  await expectError(
    await request(path + '/payment-claim', 'POST', { expectedVersion: 1 }),
    409,
    'VERSION_CONFLICT',
  )
  await expectError(await request(path + '/wechat-qr'), 404)
  assert.equal(
    await db.paymentTransaction.count({ where: { orderId: own.id } }),
    0,
  )
  await assertAdminHistory(own.id, [
    'ORDER_CREATED',
    'ADMIN_SELF_PAYMENT_CLAIMED',
  ])
  const timeline = await (await request(adminPath(own.id) + '/events')).json()
  assert(
    timeline.items.some(
      (event: { actorType: string; operation: string }) =>
        event.actorType === 'ADMIN' &&
        event.operation === 'ADMIN_SELF_PAYMENT_CLAIMED',
    ),
  )
  await expectError(
    await request(path + '/fulfill', 'POST', { expectedVersion: 2 }),
    404,
  )
  await expectError(
    await request(adminPath(own.id) + '/fulfill', 'POST', {
      expectedVersion: 2,
    }),
    409,
  )
  const record = await request(
    adminPath(own.id) + '/payment-transactions',
    'POST',
    {
      expectedVersion: 2,
      amountFen: own.amountFen,
      channel: 'WECHAT',
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    },
  )
  assert.equal(record.status, 201)
  const { paymentTransaction } = await record.json()
  assert.equal(
    (
      await request(
        '/admin/payment-transactions/' + paymentTransaction.id + '/confirm',
        'POST',
        { expectedVersion: 3 },
      )
    ).status,
    200,
  )
  await expectError(
    await request(path + '/cancel', 'POST', { expectedVersion: 4 }),
    409,
    'ORDER_NOT_CANCELLABLE',
  )
  const fulfilled = await request(adminPath(own.id) + '/fulfill', 'POST', {
    expectedVersion: 4,
  })
  assert.equal(fulfilled.status, 200)
  const { subscription } = await fulfilled.json()
  const stored = await db.subscription.findUniqueOrThrow({
    where: { id: subscription.id },
  })
  assert.equal(stored.userId, admin.id)
  assert.equal(stored.sourceOrderId, own.id)
  const listing = await request(subscriptions + '?status=ACTIVE')
  assert.equal(listing.status, 200)
  assert.deepEqual(
    (await listing.json()).items.map((row: { id: string }) => row.id),
    [subscription.id],
  )
  const details = await request(subscriptions + '/' + subscription.id)
  assert.equal(details.status, 200)
  const mine = (await details.json()).subscription
  assert.deepEqual(mine.sourceOrder, { id: own.id, orderNo: own.orderNo })
  assert.equal(Object.hasOwn(mine, 'userId'), false)
  await expectError(
    await request(subscriptions + '/' + foreignSubscription.id),
    404,
    'NOT_FOUND',
  )
  await expectError(
    await request(
      subscriptions + '/' + subscription.id,
      'GET',
      undefined,
      foreignCookie,
    ),
    404,
    'NOT_FOUND',
  )
  await expectError(await request(subscriptions + '?userId=' + foreign.id), 400)
})
