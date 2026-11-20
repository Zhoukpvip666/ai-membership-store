import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'
import { buildOrderSnapshot } from '../backend/src/modules/orders/revisions.ts'

// API-only acceptance through real browser cookies, CSRF and the Vite proxy.
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
async function setup(page: Page, context: BrowserContext) {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
    customer = await db.user.create({
      data: { loginEmail: randomUUID() + '@example.com' },
    }),
    product = await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Browser refund',
        type: 'ONE_TIME',
        priceFen: 1000,
        termLabel: 'Once',
      },
    }),
    token = newToken()
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
  await page.goto('/')
  const send = (path: string, body?: unknown, key = randomUUID()) =>
    page.evaluate(
      async ({ path, body, key }) => {
        const response = await fetch('/api/v1/admin' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'MembershipStore',
            'Idempotency-Key': key,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: response.status, body: await response.json() }
      },
      { path, body, key },
    )
  const created = await send('/orders', {
    productId: product.id,
    userId: customer.id,
    amountFen: 1000,
    formData: {},
  })
  expect(created.status).toBe(201)
  const order = created.body.order,
    recorded = await send(`/orders/${order.id}/payment-transactions`, {
      expectedVersion: 1,
      amountFen: 1000,
      channel: 'BANK_TRANSFER',
      occurredAt: order.createdAt,
      note: 'Original payment evidence',
    })
  expect(recorded.status).toBe(201)
  const paid = await send(
    `/payment-transactions/${recorded.body.paymentTransaction.id}/confirm`,
    { expectedVersion: 2 },
  )
  expect(paid.status).toBe(200)
  const cancelled = await send(`/orders/${order.id}/cancel`, {
    expectedVersion: 3,
    reason: 'Unable to deliver',
  })
  expect(cancelled.status).toBe(200)
  return {
    order: cancelled.body.order,
    send,
    payment: await db.paymentTransaction.findUniqueOrThrow({
      where: { id: recorded.body.paymentTransaction.id },
    }),
    path: `/orders/${order.id}/refunds`,
  }
}

test('ADMIN browser records externally initiated refund, confirms return and replays exact original responses', async ({
  page,
  context,
}) => {
  const { order, path, send, payment } = await setup(page, context),
    key = randomUUID(),
    body = {
      expectedVersion: 4,
      amountFen: 1000,
      channel: 'BANK_TRANSFER',
      occurredAt: order.cancelledAt,
      externalReference: 'Refund reference',
      note: 'Original refund note',
    }
  const recorded = await send(path, body, key)
  expect(recorded.status).toBe(201)
  expect(recorded.body.order).toMatchObject({
    version: 5,
    paymentStatus: 'REFUND_PENDING',
    fulfillmentStatus: 'CANCELLED',
    cancelledAt: order.cancelledAt,
    paidAt: order.paidAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
  })
  expect(recorded.body.paymentTransaction).toMatchObject({
    kind: 'REFUND',
    status: 'PENDING',
    confirmedAt: null,
    confirmedByAdminId: null,
  })
  expect((await send(path, body)).status).toBe(409)
  const refundId = recorded.body.paymentTransaction.id,
    confirmPath = `/payment-transactions/${refundId}/confirm-refund`,
    confirmKey = randomUUID()
  const confirmed = await send(confirmPath, { expectedVersion: 5 }, confirmKey)
  expect(confirmed.status).toBe(200)
  expect(confirmed.body.order).toMatchObject({
    version: 6,
    paymentStatus: 'REFUNDED',
    fulfillmentStatus: 'CANCELLED',
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    paidAt: order.paidAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
  })
  expect(confirmed.body.paymentTransaction.status).toBe('CONFIRMED')
  expect(await send(path, body, key)).toEqual(recorded)
  expect(await send(confirmPath, { expectedVersion: 5 }, confirmKey)).toEqual(
    confirmed,
  )
  expect((await send(path)).body.items).toEqual([
    confirmed.body.paymentTransaction,
  ])
  expect(
    await db.paymentTransaction.findUniqueOrThrow({
      where: { id: payment.id },
    }),
  ).toEqual(payment)
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  expect(
    (
      await db.orderRevision.findFirstOrThrow({
        where: { orderId: order.id, version: 6 },
      })
    ).snapshotJson,
  ).toEqual(buildOrderSnapshot(saved))
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(6)
  expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(6)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})

test('ADMIN browser keeps failed evidence and retries only with a new full refund attempt', async ({
  page,
  context,
}) => {
  const { order, path, send, payment } = await setup(page, context),
    body = {
      expectedVersion: 4,
      amountFen: 1000,
      channel: 'BANK_TRANSFER',
      occurredAt: order.cancelledAt,
      note: 'Original evidence retained',
    }
  expect(
    (await send(path, { ...body, channel: 'ALIPAY' })).body.error.code,
  ).toBe('REFUND_CHANNEL_MISMATCH')
  expect((await send(path, { ...body, amountFen: 900 })).body.error.code).toBe(
    'REFUND_AMOUNT_MISMATCH',
  )
  const recorded = await send(path, body)
  expect(recorded.status).toBe(201)
  const id = recorded.body.paymentTransaction.id,
    original = await db.paymentTransaction.findUniqueOrThrow({ where: { id } }),
    failPath = `/payment-transactions/${id}/fail-refund`
  expect(
    (await send(failPath, { expectedVersion: 5, reason: ' ' })).status,
  ).toBe(400)
  const key = randomUUID(),
    failed = await send(
      failPath,
      { expectedVersion: 5, reason: ' Bank rejected ' },
      key,
    )
  expect(failed.status).toBe(200)
  expect(failed.body.order).toMatchObject({
    version: 6,
    paymentStatus: 'REFUND_PENDING',
    fulfillmentStatus: 'CANCELLED',
  })
  expect(
    await send(failPath, { expectedVersion: 5, reason: 'Bank rejected' }, key),
  ).toEqual(failed)
  const saved = await db.paymentTransaction.findUniqueOrThrow({ where: { id } })
  expect(saved).toEqual({
    ...original,
    status: 'FAILED',
    updatedAt: saved.updatedAt,
  })
  const retry = await send(path, { ...body, expectedVersion: 6 })
  expect(retry.status).toBe(201)
  expect(retry.body.paymentTransaction.id).not.toBe(id)
  expect(
    (
      await send(
        `/payment-transactions/${retry.body.paymentTransaction.id}/confirm-refund`,
        { expectedVersion: 7 },
      )
    ).status,
  ).toBe(200)
  expect(
    await db.paymentTransaction.findUniqueOrThrow({ where: { id } }),
  ).toEqual(saved)
  expect(
    await db.paymentTransaction.findUniqueOrThrow({
      where: { id: payment.id },
    }),
  ).toEqual(payment)
  expect(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND' },
    }),
  ).toBe(2)
})
