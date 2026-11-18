import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDatabase } from '../../src/db/client.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'
import { integrationEnvironment } from './support.ts'
import { rejectedWithoutChanges } from './order-source-support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)

test('only three permanent order sources and append-only order records', async (t) => {
  t.after(() => db.$disconnect())
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const customer = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Order source fixture',
      type: 'SUBSCRIPTION',
      priceFen: 1000,
      renewalPriceFen: 900,
      termLabel: 'One month',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
    },
  })
  const ordinary = (source: 'ADMIN' | 'USER' = 'ADMIN') => ({
    orderNo: randomUUID(),
    userId: customer.id,
    productId: product.id,
    kind: 'INITIAL' as const,
    source,
    createdByAdminId: source === 'ADMIN' ? admin.id : null,
    createdByUserId: source === 'USER' ? customer.id : null,
    productNameSnapshot: product.name,
    productTypeSnapshot: 'SUBSCRIPTION' as const,
    termSnapshot: 'One month',
    servicePeriodUnitSnapshot: 'MONTH' as const,
    servicePeriodCountSnapshot: 1,
    amountFen: 1000,
    contactEmailSnapshot: customer.loginEmail,
  })
  const rawInsert = (
    source: Prisma.Sql | undefined,
    writer: Pick<Prisma.TransactionClient, '$executeRaw'> = db,
    mode: 'INSERT' | 'INSERT IGNORE' | 'REPLACE' = 'INSERT',
    id: string = randomUUID(),
    orderNo: string = randomUUID(),
    suffix = Prisma.empty,
    creator: 'ADMIN' | 'USER' = 'ADMIN',
  ) => {
    const sourceColumn =
      source === undefined ? Prisma.empty : Prisma.sql`, source`
    const sourceValue =
      source === undefined ? Prisma.empty : Prisma.sql`, ${source}`
    // Verb is a closed union; all record values are parameterized.
    return writer.$executeRaw(Prisma.sql`${Prisma.raw(mode)} INTO \`Order\`
      (id,orderNo,userId,productId,createdByAdminId,createdByUserId,kind,productNameSnapshot,productTypeSnapshot,termSnapshot,servicePeriodUnitSnapshot,servicePeriodCountSnapshot,amountFen,contactEmailSnapshot,updatedAt${sourceColumn})
      VALUES (${id},${orderNo},${customer.id},${product.id},${creator === 'ADMIN' ? admin.id : null},${creator === 'USER' ? customer.id : null},'INITIAL','Source fixture','SUBSCRIPTION','One month','MONTH',1,1000,${customer.loginEmail},UTC_TIMESTAMP(3)${sourceValue}) ${suffix}`)
  }

  await t.test(
    'exact three-source enum uses NULL storage with enforced required source',
    async () => {
      const [column] = await db.$queryRaw<
        {
          isNullable: string
          defaultValue: string | null
          columnType: string
        }[]
      >`SELECT IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue, COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'source'`
      assert.equal(column!.isNullable, 'YES')
      assert.equal(column!.columnType, "enum('USER','ADMIN','SYSTEM_RENEWAL')")
      assert.equal(column!.defaultValue, null)
    },
  )
  await t.test(
    'raw SQL missing/default/NULL/empty source cannot create a row',
    async (casesTest) => {
      const before = await db.order.count()
      const cases: [string, Prisma.Sql | undefined, RegExp][] = [
        ['omitted', undefined, /ORDER_SOURCE_REQUIRED|source.*default/i],
        [
          'DEFAULT',
          Prisma.raw('DEFAULT'),
          /ORDER_SOURCE_REQUIRED|source.*default/i,
        ],
        ['NULL', Prisma.sql`${null}`, /ORDER_SOURCE_REQUIRED|source.*null/i],
        [
          'empty ENUM',
          Prisma.sql`${''}`,
          /Data truncated for column 'source'|ORDER_SOURCE_REQUIRED/,
        ],
      ]
      for (const [label, source, expected] of cases)
        await casesTest.test(label, () =>
          rejectedWithoutChanges(db, () => rawInsert(source), expected),
        )
      assert.equal(await db.order.count(), before)
    },
  )
  await t.test(
    'non-strict SQL mode cannot fall back to the first ENUM value',
    async () => {
      // This test matrix compares twelve complete tables per attempt; keep a
      // test-local budget rather than changing application transaction defaults.
      await db.$transaction(
        async (tx) => {
          const [original] = await tx.$queryRaw<
            { mode: string }[]
          >`SELECT @@session.sql_mode AS mode`
          try {
            await tx.$executeRaw`SET SESSION sql_mode = ''`
            for (const mode of ['INSERT', 'INSERT IGNORE', 'REPLACE'] as const)
              for (const source of [
                undefined,
                Prisma.raw('DEFAULT'),
                Prisma.sql`'OFFLINE_MANUAL'`,
                Prisma.sql`''`,
                Prisma.sql`${null}`,
              ])
                for (const creator of ['ADMIN', 'USER'] as const)
                  await rejectedWithoutChanges(
                    tx,
                    () =>
                      rawInsert(
                        source,
                        tx,
                        mode,
                        randomUUID(),
                        randomUUID(),
                        Prisma.empty,
                        creator,
                      ),
                    /ORDER_SOURCE_REQUIRED|source.*null/i,
                  )
          } finally {
            await tx.$executeRaw`SET SESSION sql_mode = ${original!.mode}`
          }
        },
        { timeout: 30000 },
      )
    },
  )
  await t.test('removed OFFLINE_MANUAL is rejected by real MySQL', async () => {
    await rejectedWithoutChanges(
      db,
      () => rawInsert(Prisma.sql`'OFFLINE_MANUAL'`),
      /Data truncated for column 'source'|ORDER_SOURCE_REQUIRED/,
    )
  })
  const normal = await db.order.create({ data: ordinary() })
  const userOrder = await db.order.create({ data: ordinary('USER') })
  await t.test(
    'explicit ADMIN and USER continue through their normal CHECKs',
    async () => {
      assert.equal(normal.source, 'ADMIN')
      assert.equal(userOrder.source, 'USER')
      await rejectedWithoutChanges(
        db,
        () => db.order.create({ data: { ...ordinary(), kind: 'RENEWAL' } }),
        /Order_creator_check/,
      )
    },
  )
  await t.test('UPDATE and upsert cannot select a removed source', async () => {
    await rejectedWithoutChanges(
      db,
      () =>
        db.$executeRaw`UPDATE \`Order\` SET source = 'OFFLINE_MANUAL' WHERE id = ${normal.id}`,
      /Data truncated for column 'source'|ORDER_SOURCE_IMMUTABLE/,
    )
    await rejectedWithoutChanges(
      db,
      () =>
        rawInsert(
          Prisma.sql`'ADMIN'`,
          db,
          'INSERT',
          normal.id,
          normal.orderNo,
          Prisma.sql`ON DUPLICATE KEY UPDATE source = 'OFFLINE_MANUAL'`,
        ),
      /Data truncated for column 'source'|ORDER_SOURCE_IMMUTABLE/,
    )
  })
  await t.test(
    'REPLACE and INSERT IGNORE cannot create legacy-source records',
    async () => {
      for (const mode of ['REPLACE', 'INSERT IGNORE'] as const)
        await rejectedWithoutChanges(
          db,
          () =>
            rawInsert(
              Prisma.sql`'OFFLINE_MANUAL'`,
              db,
              mode,
              normal.id,
              normal.orderNo,
            ),
          /ORDER_SOURCE_REQUIRED|Data truncated for column 'source'/,
        )
      await rejectedWithoutChanges(
        db,
        () => rawInsert(undefined, db, 'INSERT IGNORE'),
        /ORDER_SOURCE_REQUIRED/,
      )
      assert.deepEqual(
        await db.order.findUniqueOrThrow({ where: { id: normal.id } }),
        normal,
      )
    },
  )
  await t.test(
    'a mixed multi-row INSERT rolls back rather than partially inserting',
    async () => {
      const before = await db.order.count()
      await rejectedWithoutChanges(
        db,
        () =>
          db.$executeRaw`INSERT INTO \`Order\` (id,orderNo,userId,productId,createdByAdminId,kind,source,productNameSnapshot,productTypeSnapshot,termSnapshot,servicePeriodUnitSnapshot,servicePeriodCountSnapshot,amountFen,contactEmailSnapshot,updatedAt)
            VALUES (${randomUUID()},${randomUUID()},${customer.id},${product.id},${admin.id},'INITIAL','ADMIN','Batch','SUBSCRIPTION','Month','MONTH',1,1000,${customer.loginEmail},UTC_TIMESTAMP(3)),
            (${randomUUID()},${randomUUID()},${customer.id},${product.id},${admin.id},'INITIAL','OFFLINE_MANUAL','Batch','SUBSCRIPTION','Month','MONTH',1,1000,${customer.loginEmail},UTC_TIMESTAMP(3))`,
        /ORDER_SOURCE_REQUIRED|Data truncated for column 'source'/,
      )
      assert.equal(await db.order.count(), before)
    },
  )

  await t.test(
    'all new sources are immutable, including ADMIN/USER conversions and UPSERT',
    async () => {
      for (const row of [normal, userOrder]) {
        for (const source of ['ADMIN', 'USER', 'SYSTEM_RENEWAL'] as const) {
          if (source === row.source) continue
          await rejectedWithoutChanges(
            db,
            () =>
              db.order.update({
                where: { id: row.id },
                data: {
                  source,
                  createdByAdminId: source === 'ADMIN' ? admin.id : null,
                  createdByUserId: source === 'USER' ? customer.id : null,
                },
              }),
            /ORDER_SOURCE_IMMUTABLE/,
          )
        }
      }
      await rejectedWithoutChanges(
        db,
        () =>
          rawInsert(
            Prisma.sql`'ADMIN'`,
            db,
            'INSERT',
            normal.id,
            normal.orderNo,
            Prisma.sql`ON DUPLICATE KEY UPDATE source = 'USER', createdByUserId = ${customer.id}, createdByAdminId = NULL`,
          ),
        /ORDER_SOURCE_IMMUTABLE/,
      )
      const updated = await db.order.update({
        where: { id: normal.id },
        data: { internalNote: 'Same-source update remains valid' },
      })
      assert.equal(updated.source, 'ADMIN')
      assert.equal(updated.internalNote, 'Same-source update remains valid')
    },
  )

  await t.test(
    'trigger metadata preserves both old renewal guards and explicit execution order',
    async () => {
      const triggers = await db.$queryRaw<
        { name: string; event: string; timing: string; position: bigint }[]
      >`
      SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event,
        ACTION_TIMING AS timing, ACTION_ORDER AS position
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'Order'`
      const group = (event: string) =>
        triggers
          .filter((row) => row.event === event)
          .sort((a, b) => Number(a.position) - Number(b.position))
          .map((row) => row.name)
      assert(triggers.every((row) => row.timing === 'BEFORE'))
      assert.deepEqual(group('INSERT'), ['Order_new_source_insert'])
      assert.deepEqual(group('UPDATE'), [
        'Order_renewal_immutable_update',
        'Order_source_immutable_update',
      ])
      assert.deepEqual(group('DELETE'), [
        'Order_paid_renewal_delete',
        'Order_delete_guard',
      ])
      const definitions = await db.$queryRaw<
        { body: string }[]
      >`SELECT ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'Order'`
      assert(definitions.every((row) => !row.body.includes('OFFLINE_MANUAL')))
      const checks = await db.$queryRaw<
        { expression: string }[]
      >`SELECT c.CHECK_CLAUSE AS expression FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = 'Order'`
      assert(
        checks.length > 0 &&
          checks.every((row) => !row.expression.includes('OFFLINE_MANUAL')),
      )
    },
  )

  await t.test(
    'ordinary USER and ADMIN payment/fulfillment and note updates remain possible',
    async () => {
      const paidAt = new Date('2028-01-01T00:00:00Z')
      const paymentConfirmedAt = new Date('2028-01-01T00:01:00Z')
      const fulfilledAt = new Date('2028-01-01T00:02:00Z')
      for (const row of [normal, userOrder]) {
        const processing = await db.order.update({
          where: { id: row.id },
          data: {
            paymentStatus: 'PAID',
            paidAt,
            paymentConfirmedAt,
            fulfillmentStatus: 'PROCESSING',
          },
        })
        assert.equal(processing.source, row.source)
        const completed = await db.order.update({
          where: { id: row.id },
          data: {
            fulfillmentStatus: 'COMPLETED',
            fulfilledAt,
            internalNote: 'Valid same-source maintenance',
          },
        })
        assert.equal(completed.fulfillmentStatus, 'COMPLETED')
        assert.equal(completed.source, row.source)
      }
    },
  )

  await t.test(
    'every ordinary order rejects DELETE and both REPLACE conflicts, with and without references',
    async () => {
      await db.orderEvent.create({
        data: {
          orderId: normal.id,
          actorType: 'ADMIN',
          actorAdminId: admin.id,
          eventType: 'NOTE',
          note: 'Referenced order fixture',
        },
      })
      await db.paymentTransaction.create({
        data: {
          orderId: normal.id,
          kind: 'PAYMENT',
          channel: 'CASH',
          amountFen: 1000,
          occurredAt: new Date('2028-01-01T00:00:00Z'),
          createdByAdminId: admin.id,
        },
      })
      const unpaid = await db.order.create({ data: ordinary('USER') })
      for (const row of [normal, userOrder, unpaid]) {
        for (const operation of [
          () => db.order.delete({ where: { id: row.id } }),
          () => db.$executeRaw`DELETE FROM \`Order\` WHERE id = ${row.id}`,
          () =>
            db.$executeRaw`DELETE IGNORE FROM \`Order\` WHERE id = ${row.id}`,
          () =>
            rawInsert(Prisma.sql`'ADMIN'`, db, 'REPLACE', row.id, randomUUID()),
          () =>
            rawInsert(
              Prisma.sql`'ADMIN'`,
              db,
              'REPLACE',
              randomUUID(),
              row.orderNo,
            ),
        ])
          await rejectedWithoutChanges(db, operation, /ORDER_DELETE_FORBIDDEN/)
      }
    },
  )

  await t.test(
    'non-strict IGNORE and UPSERT cannot change identity or replace an order',
    async () => {
      // This test matrix compares twelve complete tables per attempt; keep a
      // test-local budget rather than changing application transaction defaults.
      await db.$transaction(
        async (tx) => {
          const [original] = await tx.$queryRaw<
            { mode: string }[]
          >`SELECT @@session.sql_mode AS mode`
          try {
            await tx.$executeRaw`SET SESSION sql_mode = ''`
            for (const row of [normal, userOrder]) {
              const source = row.source === 'ADMIN' ? 'USER' : 'ADMIN'
              for (const operation of [
                () =>
                  tx.$executeRaw`UPDATE IGNORE \`Order\` SET source = ${source} WHERE id = ${row.id}`,
                () =>
                  rawInsert(
                    Prisma.sql`'ADMIN'`,
                    tx,
                    'INSERT IGNORE',
                    row.id,
                    row.orderNo,
                    Prisma.sql`ON DUPLICATE KEY UPDATE source = ${source}`,
                  ),
                () =>
                  rawInsert(
                    Prisma.sql`'ADMIN'`,
                    tx,
                    'REPLACE',
                    row.id,
                    randomUUID(),
                  ),
                () =>
                  rawInsert(
                    Prisma.sql`'ADMIN'`,
                    tx,
                    'REPLACE',
                    randomUUID(),
                    row.orderNo,
                  ),
              ])
                await rejectedWithoutChanges(
                  tx,
                  operation,
                  /ORDER_SOURCE_IMMUTABLE|ORDER_DELETE_FORBIDDEN/,
                )
            }
          } finally {
            await tx.$executeRaw`SET SESSION sql_mode = ${original!.mode}`
          }
        },
        { timeout: 30000 },
      )
    },
  )

  await t.test(
    'old SYSTEM_RENEWAL guards still reject UPDATE DELETE REPLACE and UPSERT',
    async () => {
      const start = new Date('2028-01-01T00:00:00Z')
      const end = new Date('2028-02-01T00:00:00Z')
      const sub = await db.subscription.create({
        data: {
          userId: customer.id,
          productId: product.id,
          sourceType: 'ADMIN',
          productNameSnapshot: product.name,
          productTypeSnapshot: 'SUBSCRIPTION',
          priceSnapshotFen: 1000,
          termSnapshot: product.termLabel,
          startedAt: start,
          expiresAt: end,
          renewalPriceFen: 900,
        },
      })
      const renewal = await db.order.create({
        data: {
          ...ordinary(),
          source: 'SYSTEM_RENEWAL',
          kind: 'RENEWAL',
          createdByAdminId: null,
          subscriptionId: sub.id,
          hidden: true,
          paymentStatus: 'PAID',
          fulfillmentStatus: 'COMPLETED',
          paidAt: start,
          paymentConfirmedAt: start,
          fulfilledAt: start,
          renewalForPeriodStartAt: start,
          renewalPeriodStartAt: end,
          renewalPeriodEndAt: new Date('2028-03-01T00:00:00Z'),
          billingAnchorSnapshotAt: start,
          billingTimezoneSnapshot: 'UTC',
          billingRevisionSnapshot: 1,
          renewalRequestKeyHash: randomUUID().replaceAll('-', '').repeat(2),
          renewalRequestHash: randomUUID().replaceAll('-', '').repeat(2),
        },
      })
      await db.paymentTransaction.create({
        data: {
          orderId: renewal.id,
          kind: 'PAYMENT',
          channel: 'CASH',
          amountFen: 1000,
          status: 'CONFIRMED',
          occurredAt: start,
          confirmedAt: start,
          createdByAdminId: admin.id,
          confirmedByAdminId: admin.id,
        },
      })
      await db.orderEvent.create({
        data: {
          orderId: renewal.id,
          eventType: 'COMPLETED',
          actorType: 'SYSTEM',
        },
      })
      for (const operation of [
        () =>
          db.order.update({
            where: { id: renewal.id },
            data: { internalNote: 'blocked' },
          }),
        () =>
          db.order.update({
            where: { id: renewal.id },
            data: { source: 'ADMIN' },
          }),
        () => db.order.delete({ where: { id: renewal.id } }),
        () =>
          rawInsert(
            Prisma.sql`'ADMIN'`,
            db,
            'REPLACE',
            renewal.id,
            randomUUID(),
          ),
        () =>
          rawInsert(
            Prisma.sql`'ADMIN'`,
            db,
            'REPLACE',
            randomUUID(),
            renewal.orderNo,
          ),
        () =>
          rawInsert(
            Prisma.sql`'ADMIN'`,
            db,
            'INSERT',
            renewal.id,
            renewal.orderNo,
            Prisma.sql`ON DUPLICATE KEY UPDATE internalNote = 'blocked'`,
          ),
      ])
        await rejectedWithoutChanges(db, operation, /PAID_RENEWAL_IMMUTABLE/)
    },
  )

  await t.test(
    'a failed source change rolls back earlier order-event writes too',
    async () => {
      await rejectedWithoutChanges(
        db,
        () =>
          db.$transaction(async (tx) => {
            await tx.orderEvent.create({
              data: {
                orderId: normal.id,
                eventType: 'NOTE',
                actorAdminId: admin.id,
                note: 'must roll back',
              },
            })
            await tx.order.update({
              where: { id: normal.id },
              data: {
                source: 'USER',
                createdByAdminId: null,
                createdByUserId: customer.id,
              },
            })
          }),
        /ORDER_SOURCE_IMMUTABLE/,
      )
    },
  )
})
