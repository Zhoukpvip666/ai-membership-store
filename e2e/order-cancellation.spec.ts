import { expect, test } from '@playwright/test'
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
import { buildOrderSnapshot } from '../backend/src/modules/orders/revisions.ts'

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
              ...(await activeCredentials()),
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
        : { expectedProductUpdatedAt: product.updatedAt.toISOString() }),
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

test('ADMIN browser cancels pending-verification with a mandatory reason and retains failed payment attempts', async ({
  page,
  context,
}) => {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const customer = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Pending cancellation fixture',
      type: 'ONE_TIME',
      priceFen: 1000,
      termLabel: 'Once',
    },
  })
  const order = await db.order.create({
    data: {
      orderNo: 'PENDING-' + randomUUID().replaceAll('-', ''),
      userId: customer.id,
      productId: product.id,
      kind: 'ONE_TIME',
      source: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: product.name,
      productTypeSnapshot: 'ONE_TIME',
      priceSnapshotFen: 1000,
      termSnapshot: 'Once',
      formSchemaSnapshot: { version: 1, fields: [] },
      formData: {},
      amountFen: 1000,
      contactEmailSnapshot: customer.loginEmail,
      paymentStatus: 'PENDING_VERIFICATION',
      fulfillmentStatus: 'NOT_STARTED',
    },
  })
  const v1 = await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(order),
      actorType: 'ADMIN',
      actorUserId: admin.id,
    },
  })
  const attempts = await Promise.all(
    Array.from({ length: 2 }, () =>
      db.paymentTransaction.create({
        data: {
          orderId: order.id,
          kind: 'PAYMENT',
          channel: 'CASH',
          amountFen: 1000,
          status: 'PENDING',
          occurredAt: new Date(),
          createdByAdminId: admin.id,
          externalReference: randomUUID(),
        },
      }),
    ),
  )
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
  const send = (body: unknown, key = randomUUID()) =>
    page.evaluate(
      async ({ id, body, key }) => {
        const response = await fetch('/api/v1/admin/orders/' + id + '/cancel', {
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
      { id: order.id, body, key },
    )
  for (const reason of [undefined, '   '])
    expect((await send({ expectedVersion: 1, reason })).status).toBe(400)
  expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(
    order,
  )
  for (const original of attempts)
    expect(
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: original.id },
      }),
    ).toEqual(original)
  const key = randomUUID(),
    first = await send(
      { expectedVersion: 1, reason: '  Admin checked cancellation  ' },
      key,
    )
  expect(first.status).toBe(200)
  expect(first.body.order).toMatchObject({
    version: 2,
    paymentStatus: 'UNPAID',
    fulfillmentStatus: 'CANCELLED',
    cancellationReason: 'Admin checked cancellation',
    paidAt: null,
    paymentConfirmedAt: null,
  })
  for (const original of attempts) {
    const saved = await db.paymentTransaction.findUniqueOrThrow({
      where: { id: original.id },
    })
    expect(saved).toEqual({
      ...original,
      status: 'FAILED',
      note: 'ORDER_CANCELLED',
      updatedAt: saved.updatedAt,
    })
  }
  expect(
    await send(
      { expectedVersion: 1, reason: 'Admin checked cancellation' },
      key,
    ),
  ).toEqual(first)
  expect(
    await db.orderRevision.findUniqueOrThrow({ where: { id: v1.id } }),
  ).toEqual(v1)
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(2)
  expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(1)
  expect(await db.adminAuditLog.count({ where: { entityId: order.id } })).toBe(
    1,
  )
  expect(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
  ).toBe(2)
  expect(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND' },
    }),
  ).toBe(0)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})
