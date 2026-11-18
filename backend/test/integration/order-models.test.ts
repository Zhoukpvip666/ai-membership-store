import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createDatabase } from '../../src/db/client.ts'
import type { Prisma } from '../../src/generated/prisma/client.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const anchor = new Date('2028-01-31T02:03:04.567Z')
const periodEnd = new Date('2028-02-29T02:03:04.567Z')
const paidThrough = new Date('2028-03-31T02:03:04.567Z')
const formSchema = {
  version: 1,
  fields: [{ id: 'account', type: 'text', label: 'Account', required: true }],
}

test('additive order/subscription model foundation', async (t) => {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const user = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Frozen subscription',
      description: 'Original description',
      type: 'SUBSCRIPTION',
      priceFen: 12900,
      renewalPriceFen: 9900,
      termLabel: 'One calendar month',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      formSchema,
    },
  })
  // Valid system renewals are paid and undeletable. Run model suites last;
  // cleanup removes only the runner's entire disposable project, never guards.
  t.after(() => db.$disconnect())
  const orderData = (
    extra: Partial<Prisma.OrderUncheckedCreateInput> = {},
  ): Prisma.OrderUncheckedCreateInput => ({
    orderNo: randomUUID(),
    userId: user.id,
    productId: product.id,
    kind: 'INITIAL',
    source: 'ADMIN',
    createdByAdminId: admin.id,
    productNameSnapshot: product.name,
    productDescriptionSnapshot: product.description,
    productTypeSnapshot: product.type,
    priceSnapshotFen: product.priceFen,
    termSnapshot: product.termLabel,
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    formSchemaSnapshot: formSchema,
    formData: { account: 'non-sensitive-identifier' },
    amountFen: 12900,
    renewalPriceSnapshotFen: 9900,
    contactEmailSnapshot: user.loginEmail,
    ...(extra.source === 'SYSTEM_RENEWAL'
      ? {
          paymentStatus: 'PAID',
          fulfillmentStatus: 'COMPLETED',
          paidAt: anchor,
          paymentConfirmedAt: anchor,
          fulfilledAt: anchor,
          renewalPeriodStartAt: periodEnd,
          renewalPeriodEndAt: paidThrough,
          renewalForPeriodStartAt: anchor,
          billingAnchorSnapshotAt: anchor,
          billingTimezoneSnapshot: 'Asia/Shanghai',
          billingRevisionSnapshot: 1,
          renewalRequestKeyHash: randomBytes(32).toString('hex'),
          renewalRequestHash: randomBytes(32).toString('hex'),
        }
      : {}),
    ...extra,
  })
  const initial = await db.order.create({ data: orderData() })
  const subscriptionData = (
    extra: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
  ): Prisma.SubscriptionUncheckedCreateInput => ({
    userId: user.id,
    productId: product.id,
    sourceType: 'ORDER',
    sourceOrderId: initial.id,
    productNameSnapshot: product.name,
    productTypeSnapshot: product.type,
    productDescriptionSnapshot: product.description,
    priceSnapshotFen: product.priceFen,
    termSnapshot: product.termLabel,
    formSchemaSnapshot: formSchema,
    formData: { account: 'non-sensitive-identifier' },
    renewalPriceFen: 9900,
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    billingAnchorAt: anchor,
    billingTimezone: 'Asia/Shanghai',
    billingRevision: 1,
    earlyRenewalUsed: false,
    currentPeriodStartAt: anchor,
    currentPeriodEndAt: periodEnd,
    startedAt: anchor,
    expiresAt: periodEnd,
    ...extra,
  })
  const subscription = await db.subscription.create({
    data: subscriptionData(),
  })

  await t.test(
    'fixed-day/month/year quantities and nullable legacy periods round trip; invalid pairs rejected',
    async () => {
      for (const [unit, count] of [
        ['DAY', 30],
        ['MONTH', 2],
        ['YEAR', 1],
      ] as const) {
        const result = await db.product.update({
          where: { id: product.id },
          data: { servicePeriodUnit: unit, servicePeriodCount: count },
        })
        assert.equal(result.servicePeriodUnit, unit)
        assert.equal(result.servicePeriodCount, count)
      }
      for (const data of [
        { servicePeriodUnit: 'DAY' as const, servicePeriodCount: 0 },
        { servicePeriodUnit: 'DAY' as const, servicePeriodCount: -1 },
        { servicePeriodUnit: null, servicePeriodCount: 30 },
        { servicePeriodUnit: 'DAY' as const, servicePeriodCount: null },
      ])
        await assert.rejects(
          db.product.update({ where: { id: product.id }, data }),
        )
      await assert.rejects(
        db.$executeRaw`UPDATE Product SET servicePeriodUnit = 'WEEK' WHERE id = ${product.id}`,
      )
      await db.product.update({
        where: { id: product.id },
        data: { servicePeriodUnit: null, servicePeriodCount: null },
      })
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
          .servicePeriodCount,
        null,
      )
    },
  )
  await t.test(
    'USER/ADMIN/SYSTEM_RENEWAL creators and hidden renewal records need no fake administrator',
    async () => {
      const userOrder = await db.order.create({
        data: orderData({
          source: 'USER',
          createdByAdminId: null,
          createdByUserId: user.id,
        }),
      })
      assert.equal(userOrder.createdByAdminId, null)
      assert.equal(userOrder.createdByUserId, user.id)
      const system = await db.order.create({
        data: orderData({
          billingRevisionSnapshot: 2,
          source: 'SYSTEM_RENEWAL',
          kind: 'RENEWAL',
          hidden: true,
          subscriptionId: subscription.id,
          createdByAdminId: null,
        }),
      })
      assert.equal(system.hidden, true)
      assert.equal(system.createdByUserId, null)
      assert.equal(initial.source, 'ADMIN')
      assert.equal(initial.hidden, false)
      for (const extra of [
        { source: 'USER' as const, createdByAdminId: null },
        { source: 'ADMIN' as const, createdByAdminId: null },
        {
          source: 'SYSTEM_RENEWAL' as const,
          createdByAdminId: null,
          kind: 'RENEWAL' as const,
          subscriptionId: subscription.id,
        },
      ])
        await assert.rejects(db.order.create({ data: orderData(extra) }))
    },
  )
  await t.test(
    'three order event actors preserve identity and reject ambiguous actor IDs',
    async () => {
      for (const actor of [
        { actorType: 'USER' as const, actorUserId: user.id },
        { actorType: 'ADMIN' as const, actorAdminId: admin.id },
        { actorType: 'SYSTEM' as const },
      ]) {
        const event = await db.orderEvent.create({
          data: { orderId: initial.id, eventType: 'ORDER_CREATED', ...actor },
        })
        assert.equal(event.actorType, actor.actorType)
      }
      for (const actor of [
        { actorType: 'USER' as const, actorAdminId: admin.id },
        { actorType: 'SYSTEM' as const, actorUserId: user.id },
        { actorType: 'ADMIN' as const },
      ])
        await assert.rejects(
          db.orderEvent.create({
            data: { orderId: initial.id, eventType: 'NOTE', ...actor },
          }),
        )
      await assert.rejects(db.user.delete({ where: { id: user.id } }))
    },
  )
  await t.test(
    'product changes leave order/subscription product, period, form and entered-data snapshots intact',
    async () => {
      await db.product.update({
        where: { id: product.id },
        data: {
          name: 'Edited product',
          description: 'Edited description',
          priceFen: 20000,
          renewalPriceFen: 15000,
          termLabel: 'Changed',
          servicePeriodUnit: 'DAY',
          servicePeriodCount: 30,
          formSchema: { version: 1, fields: [] },
        },
      })
      assert.deepEqual(
        await db.order.findUniqueOrThrow({ where: { id: initial.id } }),
        initial,
      )
      assert.deepEqual(
        await db.subscription.findUniqueOrThrow({
          where: { id: subscription.id },
        }),
        subscription,
      )
      await assert.rejects(
        db.order.create({ data: orderData({ servicePeriodCountSnapshot: 0 }) }),
      )
      await assert.rejects(
        db.subscription.create({
          data: subscriptionData({
            sourceOrderId: null,
            sourceType: 'ADMIN',
            servicePeriodCountSnapshot: -1,
          }),
        }),
      )
    },
  )
  await t.test(
    'ORDER subscription requires an existing unique source order; unlinked ADMIN/SYSTEM history remains valid',
    async () => {
      await assert.rejects(
        db.subscription.create({
          data: subscriptionData({ sourceOrderId: null }),
        }),
      )
      await assert.rejects(
        db.subscription.create({
          data: subscriptionData({ sourceOrderId: randomUUID() }),
        }),
      )
      await assert.rejects(db.subscription.create({ data: subscriptionData() }))
      for (const sourceType of ['ADMIN', 'SYSTEM'] as const) {
        const legacy = await db.subscription.create({
          data: subscriptionData({ sourceType, sourceOrderId: null }),
        })
        assert.equal(legacy.sourceOrderId, null)
      }
      await assert.rejects(db.order.delete({ where: { id: initial.id } }))
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } })).status,
        'PENDING_ACTIVATION',
      )
    },
  )
  await t.test(
    'new order lifecycle times reject reversed known pairs while legacy times stay compatible',
    async () => {
      for (const times of [
        { paidAt: periodEnd, paymentConfirmedAt: anchor },
        { paymentConfirmedAt: periodEnd, fulfilledAt: anchor },
        { paidAt: periodEnd, fulfilledAt: anchor, paymentConfirmedAt: null },
      ])
        await assert.rejects(
          db.order.create({ data: orderData(times) }),
          (error: unknown) =>
            /Order_payment_timeline_check/.test(String(error)),
        )
      const legacy = await db.order.create({
        data: orderData({
          source: 'OFFLINE_MANUAL',
          paymentRecordedAt: anchor,
          paymentConfirmedAt: periodEnd,
          fulfilledAt: anchor,
        }),
      })
      assert.equal(legacy.paidAt, null)
      assert.deepEqual(legacy.paymentRecordedAt, anchor)
    },
  )
  await t.test(
    'single full-payment transaction/manual confirmation and order lifecycle timestamps round trip independently',
    async () => {
      const payment = await db.paymentTransaction.create({
        data: {
          orderId: initial.id,
          kind: 'PAYMENT',
          channel: 'BANK_TRANSFER',
          amountFen: initial.amountFen,
          status: 'CONFIRMED',
          occurredAt: anchor,
          createdAt: new Date(anchor.getTime() + 30000),
          confirmedAt: periodEnd,
          createdByAdminId: admin.id,
          confirmedByAdminId: admin.id,
        },
      })
      assert.equal(payment.amountFen, initial.amountFen)
      assert.equal(payment.confirmedByAdminId, admin.id)
      // Models do not enact workflow or derive payment state; next-stage service does.
      assert.equal(
        (await db.order.findUniqueOrThrow({ where: { id: initial.id } }))
          .paymentStatus,
        'UNPAID',
      )
      const paid = await db.order.update({
        where: { id: initial.id },
        data: {
          paidAt: payment.occurredAt,
          paymentConfirmedAt: periodEnd,
          fulfilledAt: paidThrough,
          paymentStatus: 'PAID',
          fulfillmentStatus: 'COMPLETED',
        },
      })
      assert.deepEqual(paid.paidAt, payment.occurredAt)
      assert.equal(paid.paymentRecordedAt, null)
      assert.notDeepEqual(payment.createdAt, paid.paidAt)
      assert.deepEqual(paid.paymentConfirmedAt, periodEnd)
      assert.deepEqual(paid.fulfilledAt, paidThrough)
      const cancelled = await db.order.create({
        data: orderData({
          fulfillmentStatus: 'CANCELLED',
          cancelledAt: periodEnd,
          cancellationReason: 'Customer cancelled before payment',
        }),
      })
      assert.equal(cancelled.paymentStatus, 'UNPAID')
      assert.deepEqual(cancelled.cancelledAt, periodEnd)
      await db.orderEvent.create({
        data: {
          orderId: cancelled.id,
          eventType: 'CANCELLED',
          actorType: 'USER',
          actorUserId: user.id,
        },
      })
    },
  )
  await t.test(
    'billing anchor and current period remain distinct from paid-through expiry and early-renewal marker',
    async () => {
      const renewal = await db.order.create({
        data: orderData({
          kind: 'RENEWAL',
          source: 'SYSTEM_RENEWAL',
          hidden: true,
          subscriptionId: subscription.id,
          createdByAdminId: null,
        }),
      })
      const renewed = await db.subscription.update({
        where: { id: subscription.id },
        data: {
          expiresAt: paidThrough,
          earlyRenewalUsed: true,
          earlyRenewedPeriodStartAt: anchor,
          earlyRenewalOrderId: renewal.id,
          version: { increment: 1 },
        },
      })
      assert.deepEqual(renewed.billingAnchorAt, anchor)
      assert.deepEqual(renewed.currentPeriodEndAt, periodEnd)
      assert.deepEqual(renewed.expiresAt, paidThrough)
      assert.equal(
        renewed.earlyRenewedPeriodStartAt?.getTime(),
        renewed.currentPeriodStartAt?.getTime(),
      )
      assert.equal(renewed.version, 2)
      await assert.rejects(
        db.subscription.create({
          data: subscriptionData({
            sourceType: 'ADMIN',
            sourceOrderId: null,
            earlyRenewedPeriodStartAt: anchor,
            earlyRenewalOrderId: renewal.id,
          }),
        }),
      )
      await assert.rejects(
        db.subscription.update({
          where: { id: subscription.id },
          data: { earlyRenewalOrderId: null },
        }),
      )
      await assert.rejects(
        db.subscription.update({
          where: { id: subscription.id },
          data: { currentPeriodEndAt: anchor },
        }),
      )
      await assert.rejects(db.order.delete({ where: { id: renewal.id } }))
      const reopened = createDatabase(env.DATABASE_URL)
      try {
        const persisted = await reopened.subscription.findUniqueOrThrow({
          where: { id: subscription.id },
        })
        assert.deepEqual(persisted, renewed)
        const nextCycle = await reopened.subscription.update({
          where: { id: subscription.id },
          data: {
            currentPeriodStartAt: periodEnd,
            currentPeriodEndAt: paidThrough,
            earlyRenewalUsed: false,
            earlyRenewedPeriodStartAt: null,
            earlyRenewalOrderId: null,
            version: { increment: 1 },
          },
        })
        assert.notEqual(
          nextCycle.earlyRenewedPeriodStartAt?.getTime(),
          nextCycle.currentPeriodStartAt?.getTime(),
        )
        assert.deepEqual(nextCycle.billingAnchorAt, anchor)
        assert.equal(nextCycle.earlyRenewalUsed, false)
        assert.equal(nextCycle.earlyRenewalOrderId, null)
      } finally {
        await reopened.$disconnect()
      }
    },
  )
  await t.test(
    'site-wide payment instructions persist as plain text without changing existing settings',
    async () => {
      const original = await db.appSettings.findUniqueOrThrow({
        where: { id: 1 },
      })
      const text =
        'Please transfer the full amount offline.\nNo automatic charge.'
      try {
        await db.appSettings.update({
          where: { id: 1 },
          data: { paymentInstructions: text },
        })
        await assert.rejects(
          db.appSettings.update({
            where: { id: 1 },
            data: { paymentInstructions: 'x'.repeat(4001) },
          }),
        )
        const reopened = createDatabase(env.DATABASE_URL)
        try {
          const saved = await reopened.appSettings.findUniqueOrThrow({
            where: { id: 1 },
          })
          assert.equal(saved.paymentInstructions, text)
          assert.equal(saved.storeName, original.storeName)
          assert.equal(saved.ownerEmail, original.ownerEmail)
          assert.equal(saved.timezone, original.timezone)
        } finally {
          await reopened.$disconnect()
        }
      } finally {
        await db.appSettings.update({
          where: { id: 1 },
          data: { paymentInstructions: original.paymentInstructions },
        })
      }
    },
  )
})
