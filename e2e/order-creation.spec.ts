import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'

// API-only task: exercise the browser's real cookie/CSRF/proxy path, without adding UI.
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
for (const role of ['ADMIN', 'CUSTOMER'] as const) {
  test(`${role} browser creates once and replays the original role-safe order`, async ({
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
    const customer =
      role === 'CUSTOMER'
        ? actor
        : await db.user.create({
            data: { loginEmail: randomUUID() + '@example.com' },
          })
    const product = await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Browser order creation',
        type: 'SUBSCRIPTION',
        priceFen: 9900,
        renewalPriceFen: 9900,
        termLabel: 'Calendar month',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        listed: role === 'CUSTOMER',
        formSchema: {
          version: 1,
          fields: [
            { id: 'account', type: 'text', label: 'Account', required: true },
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
    const input = {
      productId: product.id,
      formData: { account: 'browser-account' },
      ...(role === 'ADMIN'
        ? {
            userId: customer.id,
            amountFen: 0,
            priceAdjustmentReason: 'Browser gift',
            internalNote: 'Private browser note',
          }
        : {}),
    }
    const key = randomUUID(),
      path = '/api/v1/' + role.toLowerCase() + '/orders'
    const send = () =>
      page.evaluate(
        async ({ path, input, key }) => {
          const response = await fetch(path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-requested-with': 'MembershipStore',
              'Idempotency-Key': key,
            },
            body: JSON.stringify(input),
          })
          return { status: response.status, body: await response.json() }
        },
        { path, input, key },
      )
    const first = await send()
    expect(first.status).toBe(201)
    expect(first.body.order.version).toBe(1)
    expect(first.body.order.paymentStatus).toBe(
      role === 'ADMIN' ? 'NOT_REQUIRED' : 'UNPAID',
    )
    expect(Object.hasOwn(first.body.order, 'internalNote')).toBe(
      role === 'ADMIN',
    )
    await db.product.update({
      where: { id: product.id },
      data: { listed: false, archivedAt: new Date(), priceFen: 1 },
    })
    expect(await send()).toEqual(first)
    expect(await db.order.count({ where: { productId: product.id } })).toBe(1)
    expect(
      await db.orderRevision.count({ where: { orderId: first.body.order.id } }),
    ).toBe(1)
    expect(
      await db.paymentTransaction.count({
        where: { orderId: first.body.order.id },
      }),
    ).toBe(0)
    expect(
      await db.subscription.count({
        where: { sourceOrderId: first.body.order.id },
      }),
    ).toBe(0)
  })
}
