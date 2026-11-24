import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import {
  activeCredentials,
  integrationEnvironment,
} from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
async function setup(
  page: Page,
  context: BrowserContext,
  subscription = true,
  zero = false,
) {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const customer = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Browser entitlement',
      type: subscription ? 'SUBSCRIPTION' : 'ONE_TIME',
      priceFen: zero ? 0 : 1000,
      renewalPriceFen: subscription ? 900 : null,
      termLabel: 'Display only',
      servicePeriodUnit: subscription ? 'MONTH' : null,
      servicePeriodCount: subscription ? 1 : null,
      formSchema: {
        version: 1,
        fields: [
          { id: 'account', label: 'Account', type: 'text', required: true },
        ],
      },
    },
  })
  const token = newToken()
  await db.session.create({
    data: {
      userId: admin.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  await page.goto('/admin/login')
  const send = (path: string, body: unknown, key = randomUUID()) =>
    page.evaluate(
      async ({ path, body, key }) => {
        const response = await fetch('/api/v1/admin' + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'MembershipStore',
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() }
      },
      { path, body, key },
    )
  const created = await send('/orders', {
    userId: customer.id,
    productId: product.id,
    amountFen: zero ? 0 : 1000,
    formData: { account: 'browser-nonsensitive-identifier' },
  })
  expect(created.status).toBe(201)
  let order = created.body.order
  if (!zero) {
    const recorded = await send(`/orders/${order.id}/payment-transactions`, {
      expectedVersion: 1,
      amountFen: 1000,
      channel: 'CASH',
      occurredAt: order.createdAt,
    })
    expect(recorded.status).toBe(201)
    const paid = await send(
      `/payment-transactions/${recorded.body.paymentTransaction.id}/confirm`,
      { expectedVersion: 2 },
    )
    expect(paid.status).toBe(200)
    order = paid.body.order
  }
  return { order, send, product, customer }
}
test('paid INITIAL browser fulfillment copies frozen snapshots, writes both audits and replays', async ({
  page,
  context,
}) => {
  const { order, send, product } = await setup(page, context)
  await db.product.update({
    where: { id: product.id },
    data: {
      name: 'Changed later',
      priceFen: 1,
      renewalPriceFen: 2,
      archivedAt: new Date(),
    },
  })
  const key = randomUUID(),
    body = { expectedVersion: 3, fulfillmentNote: ' Delivered ' },
    path = `/orders/${order.id}/fulfill`
  const completed = await send(path, body, key)
  expect(completed.status).toBe(200)
  expect(completed.body.order).toMatchObject({
    version: 4,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    paidAt: order.paidAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
  })
  expect(completed.body.subscription).toMatchObject({
    sourceType: 'ORDER',
    sourceOrderId: order.id,
    version: 1,
    status: 'ACTIVE',
    renewalPriceFen: 900,
    productNameSnapshot: 'Browser entitlement',
    priceSnapshotFen: 1000,
    formData: order.formData,
    startedAt: completed.body.order.fulfilledAt,
    billingAnchorAt: completed.body.order.fulfilledAt,
    earlyRenewalUsed: false,
    billingRevision: 1,
  })
  expect(await send(path, body, key)).toEqual(completed)
  expect((await send(path, { expectedVersion: 4 })).status).toBe(409)
  const sub = await db.subscription.findUniqueOrThrow({
    where: { sourceOrderId: order.id },
  })
  expect(
    await db.subscriptionEvent.count({
      where: { subscriptionId: sub.id, orderId: order.id },
    }),
  ).toBe(1)
  expect(
    await db.adminAuditLog.count({
      where: { entityId: order.id, action: 'ORDER_FULFILLED' },
    }),
  ).toBe(1)
  expect(
    await db.adminAuditLog.count({
      where: { entityId: sub.id, action: 'SUBSCRIPTION_CREATED' },
    }),
  ).toBe(1)
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(4)
})
test('paid ONE_TIME browser fulfillment never creates entitlement', async ({
  page,
  context,
}) => {
  const { order, send } = await setup(page, context, false)
  const result = await send(`/orders/${order.id}/fulfill`, {
    expectedVersion: 3,
  })
  expect(result.status).toBe(200)
  expect(Object.keys(result.body)).toEqual(['order'])
  expect(result.body.order.fulfillmentStatus).toBe('COMPLETED')
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})
test('zero-price concurrent browser fulfillment creates one entitlement without payments', async ({
  page,
  context,
}) => {
  const { order, send } = await setup(page, context, true, true),
    key = randomUUID(),
    path = `/orders/${order.id}/fulfill`
  const [a, b] = await Promise.all([
    send(path, { expectedVersion: 1 }, key),
    send(path, { expectedVersion: 1 }, key),
  ])
  expect(a.status).toBe(200)
  expect(b).toEqual(a)
  expect(a.body.order).toMatchObject({
    paymentStatus: 'NOT_REQUIRED',
    fulfillmentStatus: 'COMPLETED',
    paidAt: null,
    paymentConfirmedAt: null,
    version: 2,
  })
  expect(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
  ).toBe(0)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(1)
})
test('browser rejects forged fulfillment fields and CUSTOMER access without changing the order', async ({
  page,
  context,
}) => {
  const { order, send, customer } = await setup(page, context)
  const path = `/orders/${order.id}/fulfill`,
    before = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  expect(
    (
      await send(path, {
        expectedVersion: 3,
        fulfilledAt: new Date().toISOString(),
      })
    ).status,
  ).toBe(400)
  await db.user.update({
    where: { id: customer.id },
    data: { status: 'ACTIVE', ...(await activeCredentials()) },
  })
  const token = newToken()
  await db.session.create({
    data: {
      userId: customer.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  expect((await send(path, { expectedVersion: 3 })).status).toBe(403)
  expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(
    before,
  )
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})
