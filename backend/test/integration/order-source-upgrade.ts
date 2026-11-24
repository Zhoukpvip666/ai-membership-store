// Only the runner-owned disposable database; never development cleanup tooling.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Prisma } from '../../src/generated/prisma/client.ts'
import { createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'
import {
  businessSnapshot,
  rejectedWithoutChanges,
} from './order-source-support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)
const snapshotFile = process.argv[3]!
const jsonRows = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? Number(item) : item,
    ),
  )
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261118050000_order_source_final/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const firstStatement = migration.indexOf('ALTER TABLE `Order`')
assert(firstStatement > 0)
const firstDdl = migration.slice(
  firstStatement,
  migration.indexOf(';', firstStatement) + 1,
)

try {
  if (process.argv[2] === 'before') {
    // Exact fictional fixtures created under migration one, already verified
    // independently through migration seven before this cleanup.
    const rows = await db.$queryRaw<
      { id: string; orderNo: string }[]
    >`SELECT id, orderNo FROM \`Order\` WHERE source = 'OFFLINE_MANUAL' ORDER BY id`
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((row) => row.orderNo).sort(), [
      'UPGRADE-ORDER',
      'UPGRADE-PAID',
      'UPGRADE-REFUNDED',
    ])
    const checksBefore =
      await db.$queryRaw`SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME`
    // The exact first migration DDL must stop legacy data before any new trigger
    // or enum change. No legacy-to-new conversion is permitted.
    await rejectedWithoutChanges(
      db,
      () => db.$executeRawUnsafe(firstDdl),
      /Order_source_check/,
    )
    assert.deepEqual(
      await db.$queryRaw`SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME`,
      checksBefore,
    )
    const before = await businessSnapshot(db)
    const ids = rows.map((row) => row.id)
    // Authorized disposable-fixture cleanup BEFORE migrations eight/nine.
    // No protected trigger is disabled; migration SQL contains no cleanup.
    await db.$transaction(async (tx) => {
      await tx.subscription.updateMany({
        where: { sourceOrderId: { in: ids } },
        data: { sourceOrderId: null },
      })
      await tx.paymentTransaction.deleteMany({
        where: { orderId: { in: ids } },
      })
      await tx.orderEvent.deleteMany({ where: { orderId: { in: ids } } })
      assert.equal(
        (await tx.order.deleteMany({ where: { id: { in: ids } } })).count,
        3,
      )
    })
    const after = await businessSnapshot(db)
    for (const table of [
      'User',
      'Product',
      'SubscriptionEvent',
      'AdminAuditLog',
      'Session',
      'InvitationToken',
      'AppSettings',
      'IdempotencyRecord',
    ])
      assert(
        isDeepStrictEqual(after[table], before[table]),
        'Test cleanup changed unrelated ' + table,
      )
    const subscriptionsBefore = before.Subscription!.map((row) => ({
      ...row,
      sourceOrderId: null,
      updatedAt: null,
    }))
    const subscriptionsAfter = after.Subscription!.map((row) => ({
      ...row,
      sourceOrderId: null,
      updatedAt: null,
    }))
    assert(
      isDeepStrictEqual(subscriptionsAfter, subscriptionsBefore),
      'Test cleanup changed subscription contents',
    )
    assert.equal(await db.order.count(), 0)
    assert.equal(await db.paymentTransaction.count(), 0)
    assert.equal(await db.orderEvent.count(), 0)
    writeFileSync(snapshotFile, JSON.stringify(jsonRows(after)), {
      mode: 0o600,
    })
    console.info(
      'Final-source preflight rejects old test orders without changes. Only three disposable fixture orders and their payment/events cleaned; subscriptions retained with test-only source unlinking. No guard disabled.',
    )
  } else if (process.argv[2] === 'ready') {
    const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    assert(
      isDeepStrictEqual(jsonRows(await businessSnapshot(db)), expected),
      'Migrations eight/nine changed post-cleanup data',
    )
    const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
    const customer = await db.user.findFirstOrThrow({
      where: { role: 'CUSTOMER' },
    })
    const product = await db.product.findUniqueOrThrow({
      select: { id: true },
      where: { slug: 'legacy-product' },
    })
    const subscription = await db.subscription.findFirstOrThrow({
      where: {
        userId: customer.id,
        productId: product.id,
        sourceOrderId: null,
      },
    })
    const paidAt = new Date('2030-01-01T00:00:00Z')
    for (const source of ['USER', 'ADMIN', 'SYSTEM_RENEWAL'] as const) {
      const system = source === 'SYSTEM_RENEWAL'
      const data: Prisma.OrderUncheckedCreateInput = {
        orderNo: 'VALID-NINTH-' + source,
        userId: customer.id,
        productId: product.id,
        kind: system ? 'RENEWAL' : 'INITIAL',
        source,
        hidden: system,
        subscriptionId: system ? subscription.id : null,
        createdByUserId: source === 'USER' ? customer.id : null,
        createdByAdminId: source === 'ADMIN' ? admin.id : null,
        productNameSnapshot: 'Explicit new-flow fixture',
        productTypeSnapshot: 'SUBSCRIPTION',
        termSnapshot: 'Explicit test month',
        amountFen: 1234,
        contactEmailSnapshot: customer.loginEmail,
        servicePeriodUnitSnapshot: 'MONTH',
        servicePeriodCountSnapshot: 1,
        // Explicit fictional new-order data, never inferred from legacy termLabel.
        formSchemaSnapshot: { version: 1, fields: [] },
        formData: {},
        ...(system
          ? {
              paymentStatus: 'PAID',
              fulfillmentStatus: 'COMPLETED',
              paidAt,
              paymentConfirmedAt: paidAt,
              fulfilledAt: paidAt,
              renewalForPeriodStartAt: new Date('2029-12-01T00:00:00Z'),
              renewalPeriodStartAt: paidAt,
              renewalPeriodEndAt: new Date('2030-02-01T00:00:00Z'),
              billingAnchorSnapshotAt: paidAt,
              billingTimezoneSnapshot: 'UTC',
              billingRevisionSnapshot: 1,
              renewalRequestKeyHash: randomUUID().replaceAll('-', '').repeat(2),
              renewalRequestHash: randomUUID().replaceAll('-', '').repeat(2),
            }
          : {}),
      }
      // Migration-nine fixture cannot use a Client that now inserts version.
      const row = { id: randomUUID() }
      const entries = Object.entries({
        ...data,
        id: row.id,
        updatedAt: new Date(),
      })
      const columns = Prisma.join(
        entries.map(([key]) => Prisma.raw('`' + key + '`')),
      )
      const values = Prisma.join(
        entries.map(([key, value]) =>
          ['formSchemaSnapshot', 'formData'].includes(key)
            ? JSON.stringify(value)
            : value,
        ),
      )
      await db.$executeRaw(
        Prisma.sql`INSERT INTO \`Order\` (${columns}) VALUES (${values})`,
      )
      await db.orderEvent.create({
        data: {
          orderId: row.id,
          actorType: system ? 'SYSTEM' : source,
          actorAdminId: source === 'ADMIN' ? admin.id : null,
          actorUserId: source === 'USER' ? customer.id : null,
          eventType: system ? 'COMPLETED' : 'ORDER_CREATED',
        },
      })
      if (system)
        await db.paymentTransaction.create({
          data: {
            orderId: row.id,
            kind: 'PAYMENT',
            channel: 'CASH',
            amountFen: 1234,
            occurredAt: paidAt,
            status: 'CONFIRMED',
            confirmedAt: paidAt,
            createdByAdminId: admin.id,
            confirmedByAdminId: admin.id,
          },
        })
    }
    writeFileSync(
      snapshotFile,
      JSON.stringify(jsonRows(await businessSnapshot(db))),
      { mode: 0o600 },
    )
  } else if (process.argv[2] === 'after') {
    const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    // Full deploy now includes migration eleven: only its additive version and
    // in-place actor column rename may differ from the migration-nine fixture.
    for (const row of expected.Order) row.version = 1
    // Migration fifteen clears only unactivated, administrator-created profiles.
    for (const user of expected.User)
      if (
        user.role === 'CUSTOMER' &&
        user.createdByAdminId &&
        !user.activatedAt &&
        user.passwordHash === null &&
        ['PENDING_ACTIVATION', 'DISABLED'].includes(user.status)
      ) {
        user.loginEmail = null
        user.notificationEmail = null
      }
    for (const row of expected.IdempotencyRecord) {
      row.actorUserId = row.actorAdminId
      delete row.actorAdminId
    }
    assert(
      isDeepStrictEqual(jsonRows(await businessSnapshot(db)), expected),
      'Final-source migration changed fixture data after explicit cleanup',
    )
    const reopened = createDatabase(integrationEnvironment().DATABASE_URL)
    try {
      assert.equal(await reopened.order.count(), 3)
      assert.deepEqual(
        (await reopened.order.findMany({ orderBy: { source: 'asc' } }))
          .map((row) => row.source)
          .sort(),
        ['ADMIN', 'SYSTEM_RENEWAL', 'USER'],
      )
    } finally {
      await reopened.$disconnect()
    }
    console.info(
      'Cleaned historical installation upgraded through migration ten; all twelve business tables match the ninth-version snapshot, all three existing legal order sources and related records survive enum removal/reconnect unchanged.',
    )
  } else throw new Error('Expected before/ready/after source upgrade mode.')
} finally {
  await db.$disconnect()
}
