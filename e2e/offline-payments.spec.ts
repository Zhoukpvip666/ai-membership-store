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

// API-only stage: real browser cookies, CSRF and Vite proxy, no new payment UI.
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
async function setup(page: Page, context: BrowserContext) {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
    customer = await db.user.create({
      data: { loginEmail: randomUUID() + '@example.com' },
    })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Browser offline payment',
      type: 'ONE_TIME',
      priceFen: 1000,
      termLabel: 'Once',
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
    path = `/orders/${order.id}/payment-transactions`
  return { order, path, send }
}

test('ADMIN browser registers and confirms full external payment once, preserving exact time/history/replay', async ({
  page,
  context,
}) => {
  const { order, path, send } = await setup(page, context),
    key = randomUUID(),
    input = {
      expectedVersion: 1,
      amountFen: 1000,
      channel: 'WECHAT',
      occurredAt: order.createdAt,
      note: 'Original receipt note',
      externalReference: 'Offline reference',
    }
  const recorded = await send(path, input, key)
  expect(recorded.status).toBe(201)
  expect(recorded.body.order).toMatchObject({
    version: 2,
    paymentStatus: 'PENDING_VERIFICATION',
    fulfillmentStatus: 'NOT_STARTED',
    paidAt: null,
    paymentConfirmedAt: null,
  })
  expect(recorded.body.paymentTransaction).toMatchObject({
    kind: 'PAYMENT',
    status: 'PENDING',
    amountFen: 1000,
    confirmedAt: null,
    confirmedByAdminId: null,
  })
  const id = recorded.body.paymentTransaction.id,
    confirmKey = randomUUID(),
    confirmPath = `/payment-transactions/${id}/confirm`
  const confirmed = await send(confirmPath, { expectedVersion: 2 }, confirmKey)
  expect(confirmed.status).toBe(200)
  expect(confirmed.body.order).toMatchObject({
    version: 3,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'PROCESSING',
    paidAt: input.occurredAt,
    fulfilledAt: null,
  })
  expect(confirmed.body.order.paymentConfirmedAt).toBe(
    confirmed.body.paymentTransaction.confirmedAt,
  )
  expect(await send(path, input, key)).toEqual(recorded)
  expect(await send(confirmPath, { expectedVersion: 2 }, confirmKey)).toEqual(
    confirmed,
  )
  expect((await send(path)).body.items).toEqual([
    confirmed.body.paymentTransaction,
  ])
  expect((await send(confirmPath, { expectedVersion: 3 })).status).toBe(409)
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    revision = await db.orderRevision.findFirstOrThrow({
      where: { orderId: order.id, version: 3 },
    })
  expect(revision.snapshotJson).toEqual(buildOrderSnapshot(saved))
  expect(saved.paymentRecordedAt).toBe(null)
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(3)
  expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(3)
  expect(await db.adminAuditLog.count({ where: { entityId: id } })).toBe(2)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})

test('ADMIN browser must explicitly fail other pending attempts without changing their original evidence', async ({
  page,
  context,
}) => {
  const { order, path, send } = await setup(page, context),
    input = {
      expectedVersion: 1,
      amountFen: 1000,
      channel: 'BANK_TRANSFER',
      occurredAt: order.createdAt,
      externalReference: 'Reference retained',
      note: 'Original note retained',
    }
  const first = await send(path, input),
    second = await send(path, { ...input, expectedVersion: 2, amountFen: 900 })
  expect(first.status).toBe(201)
  expect(second.status).toBe(201)
  const firstId = first.body.paymentTransaction.id,
    secondId = second.body.paymentTransaction.id
  expect(
    (
      await send(`/payment-transactions/${firstId}/confirm`, {
        expectedVersion: 3,
      })
    ).body.error.code,
  ).toBe('OTHER_PENDING_PAYMENTS')
  expect(
    (
      await send(`/payment-transactions/${secondId}/confirm`, {
        expectedVersion: 3,
      })
    ).body.error.code,
  ).toBe('PAYMENT_AMOUNT_MISMATCH')
  const failPath = `/payment-transactions/${secondId}/fail`
  expect(
    (await send(failPath, { expectedVersion: 3, reason: ' ' })).status,
  ).toBe(400)
  const original = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: secondId },
    }),
    key = randomUUID(),
    body = { expectedVersion: 3, reason: '  Amount not received  ' }
  const failed = await send(failPath, body, key)
  expect(failed.status).toBe(200)
  expect(failed.body.order).toMatchObject({
    version: 4,
    paymentStatus: 'PENDING_VERIFICATION',
  })
  expect(await send(failPath, body, key)).toEqual(failed)
  const saved = await db.paymentTransaction.findUniqueOrThrow({
    where: { id: secondId },
  })
  expect(saved).toEqual({
    ...original,
    status: 'FAILED',
    updatedAt: saved.updatedAt,
  })
  expect(
    (
      await send(`/payment-transactions/${firstId}/fail`, {
        expectedVersion: 4,
        reason: 'No receipt',
      })
    ).body.order,
  ).toMatchObject({
    version: 5,
    paymentStatus: 'UNPAID',
    paidAt: null,
    paymentConfirmedAt: null,
  })
  expect(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
  ).toBe(2)
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(5)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})
