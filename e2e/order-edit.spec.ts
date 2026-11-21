import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'

// Exercise browser cookies, CSRF and the real Vite proxy; no order UI is added.
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.afterAll(() => db.$disconnect())
for (const role of ['ADMIN', 'CUSTOMER'] as const) {
  test(`${role} browser edits frozen form once, preserves history and replays exact response`, async ({
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
        name: 'Browser edit fixture',
        type: 'SUBSCRIPTION',
        priceFen: 9900,
        renewalPriceFen: 9900,
        termLabel: 'One calendar month',
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
            {
              id: 'note',
              type: 'textarea',
              label: 'Optional description',
              required: false,
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
    const prefix = '/api/v1/' + role.toLowerCase() + '/orders'
    const send = (
      method: string,
      path: string,
      body: unknown,
      key = randomUUID(),
    ) =>
      page.evaluate(
        async ({ method, path, body, key }) => {
          const response = await fetch(path, {
            method,
            headers: {
              'content-type': 'application/json',
              'x-requested-with': 'MembershipStore',
              'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        },
        { method, path, body, key },
      )
    const created = await send('POST', prefix, {
      productId: product.id,
      formData: { account: 'original', note: 'remove on replacement' },
      ...(role === 'ADMIN'
        ? { userId: target.id, amountFen: 9900, internalNote: 'Private note' }
        : { expectedProductUpdatedAt: product.updatedAt.toISOString() }),
    })
    expect(created.status).toBe(201)
    const id = created.body.order.id
    const v1 = await db.orderRevision.findFirstOrThrow({
      where: { orderId: id, version: 1 },
    })
    await db.product.update({
      where: { id: product.id },
      data: {
        listed: false,
        archivedAt: new Date(),
        name: 'New catalog name',
        formSchema: {
          version: 1,
          fields: [
            {
              id: 'different',
              type: 'text',
              label: 'New schema',
              required: true,
            },
          ],
        },
      },
    })
    const key = randomUUID(),
      body = {
        expectedVersion: 1,
        formData: { account: 'updated' },
        ...(role === 'ADMIN'
          ? { amountFen: 0, priceAdjustmentReason: 'Gift' }
          : {}),
      }
    const first = await send('PATCH', prefix + '/' + id, body, key)
    expect(first.status).toBe(200)
    expect(first.body.order.version).toBe(2)
    expect(first.body.order.formData).toEqual({ account: 'updated' })
    expect(first.body.order.formSchemaSnapshot).toEqual(
      created.body.order.formSchemaSnapshot,
    )
    expect(first.body.order.expiresAt).toBe(created.body.order.expiresAt)
    expect(first.body.order.productNameSnapshot).toBe('Browser edit fixture')
    expect(Object.hasOwn(first.body.order, 'internalNote')).toBe(
      role === 'ADMIN',
    )
    expect(first.body.order.paymentStatus).toBe(
      role === 'ADMIN' ? 'NOT_REQUIRED' : 'UNPAID',
    )
    const stale = await send('PATCH', prefix + '/' + id, {
      expectedVersion: 1,
      formData: { account: 'stale' },
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe(
      role === 'ADMIN' ? 'ORDER_NOT_EDITABLE' : 'VERSION_CONFLICT',
    )
    if (role === 'CUSTOMER')
      expect(
        (
          await send('PATCH', prefix + '/' + id, {
            expectedVersion: 2,
            formData: { account: 'later edit' },
          })
        ).status,
      ).toBe(200)
    expect(await send('PATCH', prefix + '/' + id, body, key)).toEqual(first)
    expect(
      await db.orderRevision.findUniqueOrThrow({ where: { id: v1.id } }),
    ).toEqual(v1)
    expect(await db.orderRevision.count({ where: { orderId: id } })).toBe(
      role === 'ADMIN' ? 2 : 3,
    )
    expect(await db.orderEvent.count({ where: { orderId: id } })).toBe(
      role === 'ADMIN' ? 2 : 3,
    )
    expect(await db.paymentTransaction.count({ where: { orderId: id } })).toBe(
      0,
    )
    expect(await db.subscription.count({ where: { sourceOrderId: id } })).toBe(
      0,
    )
  })
}
