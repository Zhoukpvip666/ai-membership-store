import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'

// Real browser cookie/CSRF/Vite proxy against disposable MySQL. No order UI.
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
for (const role of ['ADMIN', 'CUSTOMER'] as const) {
  test(`${role} browser cancels once, preserves history and replays the original safe DTO`, async ({
    page,
    context,
  }) => {
    const actor =
      role === 'ADMIN'
        ? await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
        : await db.user.create({
            data: {
              loginEmail: randomUUID() + '@example.com',
              status: 'ACTIVE',
            },
          })
    const target =
      role === 'CUSTOMER'
        ? actor
        : await db.user.create({
            data: { loginEmail: randomUUID() + '@example.com' },
          })
    const product = await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Browser cancellation fixture',
        type: 'SUBSCRIPTION',
        priceFen: 9900,
        renewalPriceFen: 9900,
        termLabel: 'One month',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        listed: role === 'CUSTOMER',
        formSchema: {
          version: 1,
          fields: [
            {
              id: 'account',
              type: 'text',
              label: 'Account identifier',
              required: true,
            },
          ],
        },
      },
    })
    const token = newToken()
    await db.session.create({
      data: {
        userId: actor.id,
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
    const send = (path: string, body: unknown, key = randomUUID()) =>
      page.evaluate(
        async ({ path, body, key }) => {
          const response = await fetch(path, {
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
    const prefix = '/api/v1/' + role.toLowerCase() + '/orders'
    const created = await send(prefix, {
      productId: product.id,
      formData: { account: 'browser-account' },
      ...(role === 'ADMIN'
        ? {
            userId: target.id,
            amountFen: 0,
            priceAdjustmentReason: 'Gift',
            internalNote: 'PRIVATE_NOTE',
          }
        : {}),
    })
    expect(created.status).toBe(201)
    const id = created.body.order.id,
      v1 = await db.orderRevision.findFirstOrThrow({
        where: { orderId: id, version: 1 },
      })
    const key = randomUUID(),
      body = {
        expectedVersion: 1,
        reason: '  Browser requested cancellation  ',
      }
    const first = await send(prefix + '/' + id + '/cancel', body, key)
    expect(first.status).toBe(200)
    expect(first.body.order.version).toBe(2)
    expect(first.body.order.fulfillmentStatus).toBe('CANCELLED')
    expect(first.body.order.paymentStatus).toBe(
      role === 'ADMIN' ? 'NOT_REQUIRED' : 'UNPAID',
    )
    expect(first.body.order.remainingSeconds).toBe(0)
    expect(first.body.order.expiresAt).toBe(created.body.order.expiresAt)
    expect(first.body.order.formData).toEqual(created.body.order.formData)
    expect(first.body.order.paidAt).toBeNull()
    expect(first.body.order.paymentConfirmedAt).toBeNull()
    expect(Object.hasOwn(first.body.order, 'internalNote')).toBe(
      role === 'ADMIN',
    )
    expect(
      await send(
        prefix + '/' + id + '/cancel',
        { ...body, reason: 'Browser requested cancellation' },
        key,
      ),
    ).toEqual(first)
    const repeat = await send(prefix + '/' + id + '/cancel', {
      expectedVersion: 2,
      reason: 'Again',
    })
    expect(repeat.status).toBe(409)
    expect(repeat.body.error.code).toBe('ORDER_NOT_CANCELLABLE')
    expect(
      await db.orderRevision.findUniqueOrThrow({ where: { id: v1.id } }),
    ).toEqual(v1)
    expect(await db.orderRevision.count({ where: { orderId: id } })).toBe(2)
    expect(await db.orderEvent.count({ where: { orderId: id } })).toBe(2)
    expect(await db.adminAuditLog.count({ where: { entityId: id } })).toBe(
      role === 'ADMIN' ? 2 : 0,
    )
    expect(await db.paymentTransaction.count({ where: { orderId: id } })).toBe(
      0,
    )
    expect(await db.subscription.count({ where: { sourceOrderId: id } })).toBe(
      0,
    )
  })
}
