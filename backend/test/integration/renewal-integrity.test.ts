// Schema/SQL fixtures only; no order API or payment workflow is implemented here.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createDatabase } from '../../src/db/client.ts'
import type { Prisma } from '../../src/generated/prisma/client.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const anchor = new Date('2028-01-31T02:00:00.000Z')
const paidAt = new Date(anchor.getTime() - 120000)
const confirmedAt = new Date(anchor.getTime() - 60000)
const transactionCreatedAt = new Date(anchor.getTime() + 1)
const end = new Date('2028-02-29T02:00:00.000Z')
const next = new Date('2028-03-31T02:00:00.000Z')

async function rejected(promise: PromiseLike<unknown>, expected: RegExp) {
  await assert.rejects(Promise.resolve(promise), (error: unknown) =>
    expected.test(String(error)),
  )
}

test('review constraints and immutable renewal purchase evidence', async (t) => {
  // Paid orders cannot be deleted, even by test cleanup. The runner executes this
  // suite last and removes only its random disposable Compose project afterwards.
  t.after(() => db.$disconnect())
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const customer = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Review fixture',
      type: 'SUBSCRIPTION',
      priceFen: 9900,
      renewalPriceFen: 9900,
      termLabel: 'one month',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
    },
  })
  const ordinary = (
    extra: Partial<Prisma.OrderUncheckedCreateInput> = {},
  ): Prisma.OrderUncheckedCreateInput => ({
    orderNo: randomUUID(),
    userId: customer.id,
    productId: product.id,
    source: 'ADMIN',
    kind: 'INITIAL',
    createdByAdminId: admin.id,
    productNameSnapshot: product.name,
    productTypeSnapshot: 'SUBSCRIPTION',
    priceSnapshotFen: 9900,
    amountFen: 9900,
    renewalPriceSnapshotFen: 9900,
    termSnapshot: product.termLabel,
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    formSchemaSnapshot: { version: 1, fields: [] },
    formData: {},
    contactEmailSnapshot: customer.loginEmail,
    ...extra,
  })
  const initial = await db.order.create({
    data: ordinary({
      paymentStatus: 'PAID',
      fulfillmentStatus: 'COMPLETED',
      paymentConfirmedAt: anchor,
      fulfilledAt: anchor,
    }),
  })
  const subData: Prisma.SubscriptionUncheckedCreateInput = {
    userId: customer.id,
    productId: product.id,
    sourceType: 'ORDER',
    sourceOrderId: initial.id,
    productNameSnapshot: product.name,
    productTypeSnapshot: 'SUBSCRIPTION',
    priceSnapshotFen: 9900,
    termSnapshot: product.termLabel,
    servicePeriodUnitSnapshot: 'MONTH',
    servicePeriodCountSnapshot: 1,
    billingAnchorAt: anchor,
    billingTimezone: 'Asia/Shanghai',
    billingRevision: 1,
    currentPeriodStartAt: anchor,
    currentPeriodEndAt: end,
    earlyRenewalUsed: false,
    startedAt: anchor,
    expiresAt: end,
    renewalPriceFen: 9900,
  }
  const sub = await db.subscription.create({ data: subData })
  const renewal = (extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    ordinary({
      source: 'SYSTEM_RENEWAL',
      kind: 'RENEWAL',
      createdByAdminId: null,
      hidden: true,
      subscriptionId: sub.id,
      paymentStatus: 'PAID',
      fulfillmentStatus: 'COMPLETED',
      paidAt,
      paymentConfirmedAt: confirmedAt,
      fulfilledAt: anchor,
      createdAt: anchor,
      renewalForPeriodStartAt: anchor,
      renewalPeriodStartAt: end,
      renewalPeriodEndAt: next,
      billingAnchorSnapshotAt: anchor,
      billingTimezoneSnapshot: 'Asia/Shanghai',
      billingRevisionSnapshot: 1,
      renewalRequestKeyHash: randomBytes(32).toString('hex'),
      renewalRequestHash: randomBytes(32).toString('hex'),
      ...extra,
    })

  await t.test(
    'USER and ADMIN permit visible INITIAL/ONE_TIME only',
    async () => {
      for (const source of ['USER', 'ADMIN'] as const) {
        const creator =
          source === 'USER'
            ? { createdByUserId: customer.id, createdByAdminId: null }
            : { createdByAdminId: admin.id }
        for (const kind of ['INITIAL', 'ONE_TIME'] as const) {
          const row = await db.order.create({
            data: ordinary({
              source,
              kind,
              ...creator,
              productTypeSnapshot:
                kind === 'ONE_TIME' ? 'ONE_TIME' : 'SUBSCRIPTION',
              servicePeriodUnitSnapshot: kind === 'ONE_TIME' ? null : 'MONTH',
              servicePeriodCountSnapshot: kind === 'ONE_TIME' ? null : 1,
            }),
          })
          assert.equal(row.hidden, false)
        }
        for (const extra of [
          { kind: 'RENEWAL' as const },
          { kind: 'RENEWAL' as const, hidden: true, subscriptionId: sub.id },
          { hidden: true },
          { subscriptionId: sub.id },
        ])
          await rejected(
            db.order.create({
              data: ordinary({ source, ...creator, ...extra }),
            }),
            /Order_creator_check/,
          )
      }
      await rejected(
        db.order.update({ where: { id: initial.id }, data: { hidden: true } }),
        /Order_creator_check/,
      )
      for (const extra of [
        { subscriptionId: null },
        { hidden: false },
        { kind: 'INITIAL' as const },
        { kind: 'ONE_TIME' as const },
        { createdByAdminId: admin.id },
        { createdByUserId: customer.id },
        { productTypeSnapshot: 'ONE_TIME' as const },
      ])
        await rejected(
          db.order.create({ data: renewal(extra) }),
          /Order_creator_check/,
        )
    },
  )

  await t.test(
    'ORDER subscriptions require complete periods, valid zones and initialized eligibility',
    async () => {
      const unclaimed = await db.order.create({ data: ordinary() })
      for (const data of [
        { productTypeSnapshot: 'ONE_TIME' as const },
        { sourceOrderId: null },
        { servicePeriodUnitSnapshot: null, servicePeriodCountSnapshot: null },
        { billingAnchorAt: null },
        { billingTimezone: null },
        { billingTimezone: '' },
        { billingTimezone: 'Mars/Olympus_Mons' },
        { billingTimezone: 'asia/shanghai' },
        { billingRevision: null },
        { billingRevision: 0 },
        { currentPeriodStartAt: null, currentPeriodEndAt: null },
        { earlyRenewalUsed: null },
        { earlyRenewalUsed: true },
      ]) {
        const expected =
          /Subscription_(order_complete|order_source|service_period|current_period|early_renewal)_check/
        await rejected(
          db.subscription.update({ where: { id: sub.id }, data }),
          expected,
        )
        await rejected(
          db.subscription.create({
            data: {
              ...subData,
              sourceOrderId: unclaimed.id,
              ...data,
            },
          }),
          expected,
        )
      }
      for (const billingTimezone of [
        'UTC',
        'Etc/UTC',
        'Etc/GMT-8',
        'America/Los_Angeles',
        'Asia/Shanghai',
      ]) {
        await db.subscription.update({
          where: { id: sub.id },
          data: { billingTimezone },
        })
      }
      await rejected(
        db.order.create({
          data: ordinary({
            servicePeriodUnitSnapshot: null,
            servicePeriodCountSnapshot: null,
          }),
        }),
        /Order_new_subscription_period_check/,
      )
    },
  )

  await t.test(
    'legacy orders and unlinked ADMIN/SYSTEM subscriptions retain unknown periods',
    async () => {
      for (const sourceType of ['ADMIN', 'SYSTEM'] as const) {
        const legacy = await db.subscription.create({
          data: {
            ...subData,
            sourceType,
            sourceOrderId: null,
            servicePeriodUnitSnapshot: null,
            servicePeriodCountSnapshot: null,
            billingAnchorAt: null,
            billingTimezone: null,
            billingRevision: null,
            currentPeriodStartAt: null,
            currentPeriodEndAt: null,
            earlyRenewalUsed: null,
            termSnapshot: '30 days (unverified historical text)',
          },
        })
        assert.equal(legacy.servicePeriodCountSnapshot, null)
        assert.equal(legacy.billingRevision, null)
        assert.equal(legacy.sourceOrderId, null)
      }
      const legacy = await db.order.create({
        data: ordinary({
          source: 'OFFLINE_MANUAL',
          kind: 'RENEWAL',
          servicePeriodUnitSnapshot: null,
          servicePeriodCountSnapshot: null,
        }),
      })
      assert.equal(legacy.servicePeriodUnitSnapshot, null)
    },
  )

  await t.test(
    'renewal cycle/anchor/revision snapshots are mandatory',
    async () => {
      for (const key of [
        'renewalPeriodStartAt',
        'renewalPeriodEndAt',
        'renewalForPeriodStartAt',
        'billingAnchorSnapshotAt',
        'billingTimezoneSnapshot',
        'billingRevisionSnapshot',
        'renewalRequestKeyHash',
        'renewalRequestHash',
      ])
        await rejected(
          db.order.create({ data: renewal({ [key]: null }) }),
          /Order_renewal_snapshot_check/,
        )
      for (const extra of [
        { renewalPeriodEndAt: end },
        { renewalForPeriodStartAt: end },
        { billingRevisionSnapshot: 0 },
        { billingTimezoneSnapshot: 'Invalid/Zone' },
        { renewalRequestKeyHash: 'x'.repeat(64) },
        { renewalRequestHash: '' },
      ])
        await rejected(
          db.order.create({ data: renewal(extra) }),
          /Order_renewal_snapshot_check/,
        )
    },
  )

  await t.test(
    'SQL CHECK rejects every unfinished or incomplete system renewal INSERT',
    async () => {
      const cases: [string, Partial<Prisma.OrderUncheckedCreateInput>][] = [
        ['paid but processing', { fulfillmentStatus: 'PROCESSING' }],
        ['paid but not started', { fulfillmentStatus: 'NOT_STARTED' }],
        ['paid but failed', { fulfillmentStatus: 'FAILED' }],
        ['paid but cancelled', { fulfillmentStatus: 'CANCELLED' }],
        ['unpaid but completed', { paymentStatus: 'UNPAID' }],
        ['unverified but completed', { paymentStatus: 'PENDING_VERIFICATION' }],
        ['refund pending', { paymentStatus: 'REFUND_PENDING' }],
        ['refunded', { paymentStatus: 'REFUNDED' }],
        ['payment time NULL', { paidAt: null }],
        ['confirmation time NULL', { paymentConfirmedAt: null }],
        ['fulfillment time NULL', { fulfilledAt: null }],
        ['payment time omitted', { paidAt: undefined }],
        [
          'legacy recording time is not actual payment',
          { paidAt: null, paymentRecordedAt: anchor },
        ],
        ['confirmation time omitted', { paymentConfirmedAt: undefined }],
        ['fulfillment time omitted', { fulfilledAt: undefined }],
        [
          'all times NULL',
          {
            paidAt: null,
            paymentConfirmedAt: null,
            fulfilledAt: null,
          },
        ],
        ['cancellation time present', { cancelledAt: anchor }],
        [
          'confirmation before actual payment',
          { paidAt: new Date(confirmedAt.getTime() + 1) },
        ],
        [
          'fulfillment before confirmation',
          { fulfilledAt: new Date(confirmedAt.getTime() - 1) },
        ],
      ]
      const before = await db.order.count({
        where: { source: 'SYSTEM_RENEWAL' },
      })
      for (const [name, data] of cases) {
        await rejected(
          db.order.create({ data: renewal(data) }),
          /Order_(system_renewal_final|payment_timeline)_check/,
        )
        assert.equal(
          await db.order.count({ where: { source: 'SYSTEM_RENEWAL' } }),
          before,
          name,
        )
      }
      // Direct SQL also exercises MySQL's CHECK/NULL logic without any Zod path.
      await rejected(
        db.$executeRaw`INSERT INTO \`Order\` (id,orderNo,userId,productId,subscriptionId,kind,source,hidden,productNameSnapshot,productTypeSnapshot,termSnapshot,amountFen,contactEmailSnapshot,servicePeriodUnitSnapshot,servicePeriodCountSnapshot,renewalForPeriodStartAt,renewalPeriodStartAt,renewalPeriodEndAt,billingAnchorSnapshotAt,billingTimezoneSnapshot,billingRevisionSnapshot,renewalRequestKeyHash,renewalRequestHash,paymentStatus,fulfillmentStatus,paidAt,paymentConfirmedAt,fulfilledAt,updatedAt) VALUES (${randomUUID()},${randomUUID()},${customer.id},${product.id},${sub.id},'RENEWAL','SYSTEM_RENEWAL',true,'Review fixture','SUBSCRIPTION','one month',9900,${customer.loginEmail},'MONTH',1,${anchor},${end},${next},${anchor},'Asia/Shanghai',1,${randomBytes(32).toString('hex')},${randomBytes(32).toString('hex')},'PAID','COMPLETED',NULL,NULL,NULL,UTC_TIMESTAMP(3))`,
        /Order_system_renewal_final_check/,
      )
      // Equal instants are allowed. Roll back the fixture without deleting paid history.
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.order.create({
            data: renewal({
              paidAt: anchor,
              paymentConfirmedAt: anchor,
              fulfilledAt: anchor,
            }),
          })
          throw new Error('equal-instants-accepted')
        }),
        /equal-instants-accepted/,
      )
    },
  )

  // Reserve identity in memory; never INSERT/delete an unpaid system order.
  const purchase = {
    id: randomUUID(),
    orderNo: randomUUID(),
    renewalRequestKeyHash: randomBytes(32).toString('hex'),
    renewalRequestHash: randomBytes(32).toString('hex'),
  }
  async function fulfillFixture(failure?: 'audit' | 'trigger') {
    // This is a schema integration fixture, not a production fulfillment handler.
    return db.$transaction(async (tx) => {
      const completed = await tx.order.create({
        data: {
          ...renewal({
            id: purchase.id,
            orderNo: purchase.orderNo,
            renewalRequestKeyHash: purchase.renewalRequestKeyHash!,
            renewalRequestHash: purchase.renewalRequestHash!,
          }),
          paymentStatus: 'PAID',
          fulfillmentStatus: 'COMPLETED',
          paidAt,
          paymentConfirmedAt: confirmedAt,
          fulfilledAt: anchor,
        },
      })
      await tx.paymentTransaction.create({
        data: {
          orderId: purchase.id,
          kind: 'PAYMENT',
          channel: 'BANK_TRANSFER',
          amountFen: 9900,
          status: 'CONFIRMED',
          occurredAt: paidAt,
          confirmedAt,
          createdAt: transactionCreatedAt,
          createdByAdminId: admin.id,
          confirmedByAdminId: admin.id,
        },
      })
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          expiresAt: next,
          earlyRenewalUsed: true,
          earlyRenewedPeriodStartAt: anchor,
          earlyRenewalOrderId: purchase.id,
          version: { increment: 1 },
        },
      })
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: sub.id,
          orderId: purchase.id,
          eventType: 'RENEWED',
          actorType: 'SYSTEM',
        },
      })
      await tx.orderEvent.create({
        data: {
          orderId: purchase.id,
          eventType: 'COMPLETED',
          actorType: 'SYSTEM',
        },
      })
      await tx.adminAuditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'RENEWAL_FIXTURE',
          entityType: 'Order',
          entityId: purchase.id,
          ...(failure === 'audit' ? { actorAdminId: randomUUID() } : {}),
        },
      })
      if (failure === 'trigger')
        await tx.order.update({
          where: { id: completed.id },
          data: { internalNote: 'must roll back' },
        })
      return completed
    })
  }
  await t.test(
    'order/payment/subscription/events/audit all roll back on audit or trigger failure',
    async () => {
      const before = await db.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      })
      for (const failure of ['audit', 'trigger'] as const) {
        if (failure === 'audit')
          await assert.rejects(fulfillFixture(failure), { code: 'P2003' })
        else await rejected(fulfillFixture(failure), /PAID_RENEWAL_IMMUTABLE/)
        assert.equal(
          await db.order.findUnique({ where: { id: purchase.id } }),
          null,
        )
        assert.deepEqual(
          await db.subscription.findUniqueOrThrow({ where: { id: sub.id } }),
          before,
        )
        assert.equal(
          await db.paymentTransaction.count({
            where: { orderId: purchase.id },
          }),
          0,
        )
        assert.equal(
          await db.subscriptionEvent.count({ where: { orderId: purchase.id } }),
          0,
        )
        assert.equal(
          await db.orderEvent.count({ where: { orderId: purchase.id } }),
          0,
        )
        assert.equal(
          await db.adminAuditLog.count({ where: { entityId: purchase.id } }),
          0,
        )
      }
    },
  )
  const completed = await fulfillFixture()
  await t.test(
    'one final INSERT permits subscription/payment/events/audit in the same transaction',
    async () => {
      assert.equal(completed.paymentStatus, 'PAID')
      assert.equal(completed.fulfillmentStatus, 'COMPLETED')
      assert.deepEqual(completed.paidAt, paidAt)
      assert.deepEqual(completed.paymentConfirmedAt, confirmedAt)
      assert.deepEqual(completed.fulfilledAt, anchor)
      assert.equal(completed.paymentRecordedAt, null)
      assert.equal(completed.cancelledAt, null)
      const payment = await db.paymentTransaction.findFirstOrThrow({
        where: { orderId: completed.id, kind: 'PAYMENT' },
      })
      assert.deepEqual(payment.occurredAt, completed.paidAt)
      assert.deepEqual(payment.confirmedAt, completed.paymentConfirmedAt)
      assert.deepEqual(payment.createdAt, transactionCreatedAt)
      assert(payment.createdAt > payment.confirmedAt!)
      assert.notDeepEqual(payment.createdAt, payment.occurredAt)
      const updated = await db.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      })
      assert.deepEqual(updated.expiresAt, next)
      assert.equal(updated.earlyRenewalUsed, true)
      assert.equal(updated.earlyRenewalOrderId, completed.id)
      assert.equal(updated.version, sub.version + 1)
      assert.equal(
        await db.paymentTransaction.count({ where: { orderId: completed.id } }),
        1,
      )
      assert.equal(
        await db.subscriptionEvent.count({ where: { orderId: completed.id } }),
        1,
      )
      assert.equal(
        await db.orderEvent.count({ where: { orderId: completed.id } }),
        1,
      )
      assert.equal(
        await db.adminAuditLog.count({ where: { entityId: completed.id } }),
        1,
      )
    },
  )
  await t.test(
    'stable cycle claims reject duplicate successful orders',
    async () => {
      for (const extra of [
        {},
        {
          renewalPeriodStartAt: next,
          renewalPeriodEndAt: new Date('2028-04-30T02:00:00Z'),
        },
        { renewalForPeriodStartAt: new Date(anchor.getTime() + 1) },
      ])
        await assert.rejects(db.order.create({ data: renewal(extra) }), {
          code: 'P2002',
        })
    },
  )
  await t.test(
    'paid/completed renewal cannot be edited, cancelled, deleted or fulfilled again',
    async () => {
      for (const data of [
        { renewalPeriodStartAt: new Date(end.getTime() + 1) },
        { renewalPeriodEndAt: new Date(next.getTime() + 1) },
        { renewalForPeriodStartAt: new Date(anchor.getTime() + 1) },
        { billingAnchorSnapshotAt: end },
        { billingRevisionSnapshot: 2 },
        { billingTimezoneSnapshot: 'UTC' },
        { subscriptionId: randomUUID() },
        { productNameSnapshot: product.name.toUpperCase() },
        { source: 'ADMIN' as const, kind: 'INITIAL' as const, hidden: false },
        { internalNote: 'change' },
        { paymentStatus: 'UNPAID' as const },
        { fulfillmentStatus: 'CANCELLED' as const, cancelledAt: next },
        { fulfilledAt: next },
        { fulfilledAt: null },
        { paidAt: null },
        { paidAt: next },
        { paymentRecordedAt: anchor },
        { paymentConfirmedAt: null },
      ])
        await rejected(
          db.order.update({ where: { id: completed.id }, data }),
          /PAID_RENEWAL_IMMUTABLE/,
        )
      await rejected(
        db.order.delete({ where: { id: completed.id } }),
        /PAID_RENEWAL_IMMUTABLE/,
      )
      await rejected(
        db.$executeRaw`UPDATE \`Order\` SET internalNote = 'blocked' WHERE id = ${completed.id}`,
        /PAID_RENEWAL_IMMUTABLE/,
      )
      await rejected(
        db.$executeRaw`DELETE FROM \`Order\` WHERE id = ${completed.id}`,
        /PAID_RENEWAL_IMMUTABLE/,
      )
      assert.deepEqual(
        await db.order.findUniqueOrThrow({ where: { id: completed.id } }),
        completed,
      )
      await assert.rejects(fulfillFixture(), { code: 'P2002' })
      assert.equal(
        await db.subscriptionEvent.count({ where: { orderId: purchase.id } }),
        1,
      )
    },
  )

  await t.test(
    'manual anchor reset has a separate revision and leaves old purchase evidence unchanged',
    async () => {
      const before = await db.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      })
      const noted = await db.subscription.update({
        where: { id: sub.id },
        data: { note: 'fixture note', version: { increment: 1 } },
      })
      assert.equal(noted.billingRevision, before.billingRevision)
      assert.equal(noted.version, before.version + 1)
      const adjustedExpiry = new Date('2028-03-15T02:00:00.000Z')
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          expiresAt: adjustedExpiry,
          billingAnchorAt: adjustedExpiry,
          billingRevision: { increment: 1 },
          currentPeriodStartAt: end,
          currentPeriodEndAt: adjustedExpiry,
          earlyRenewalUsed: false,
          earlyRenewalOrderId: null,
          earlyRenewedPeriodStartAt: null,
          version: { increment: 1 },
        },
      })
      assert.deepEqual(
        await db.order.findUniqueOrThrow({ where: { id: purchase.id } }),
        completed,
      )
      await assert.rejects(db.order.create({ data: renewal() }), {
        code: 'P2002',
      })
      await rejected(
        db.order.update({
          where: { id: purchase.id },
          data: { billingRevisionSnapshot: 2 },
        }),
        /PAID_RENEWAL_IMMUTABLE/,
      )
      // Reusing the original request after an anchor reset must not buy a new cycle.
      await assert.rejects(
        db.order.create({
          data: renewal({
            billingRevisionSnapshot: 2,
            billingAnchorSnapshotAt: adjustedExpiry,
            renewalForPeriodStartAt: end,
            renewalPeriodStartAt: adjustedExpiry,
            renewalPeriodEndAt: new Date('2028-04-15T02:00:00.000Z'),
            renewalRequestKeyHash: completed.renewalRequestKeyHash!,
            renewalRequestHash: completed.renewalRequestHash!,
          }),
        }),
        { code: 'P2002' },
      )
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          db.order.create({
            data: renewal({
              billingRevisionSnapshot: 2,
              billingAnchorSnapshotAt: adjustedExpiry,
              renewalForPeriodStartAt: end,
              renewalPeriodStartAt: adjustedExpiry,
              renewalPeriodEndAt: new Date('2028-04-15T02:00:00.000Z'),
            }),
          }),
        ),
      )
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      const loser = results.find((r) => r.status === 'rejected')
      assert.equal(loser?.status === 'rejected' && loser.reason.code, 'P2002')
    },
  )
})
