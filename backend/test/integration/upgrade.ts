// This fixture runs only inside the random disposable test database.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { hashPassword, tokenHash } from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'
import {
  migrationPreflight,
  SuspendedMigrationError,
} from '../../src/db/migration-preflight.ts'
import { authService } from '../../src/modules/auth/service.ts'
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const snapshotFile = process.argv[3]!
async function snapshot() {
  return JSON.parse(
    JSON.stringify(
      {
        users: await db.$queryRaw`SELECT * FROM User ORDER BY id`,
        sessions: await db.session.findMany(),
        invitations: await db.invitationToken.findMany(),
        products:
          await db.$queryRaw`SELECT id,slug,name,description,type,priceFen,renewalPriceFen,termLabel,targetField,listed,archivedAt,createdAt,updatedAt FROM Product ORDER BY id`,
        orders: await db.$queryRaw`SELECT * FROM \`Order\` ORDER BY id`,
        subscriptions:
          await db.$queryRaw`SELECT * FROM Subscription ORDER BY id`,
        payments: await db.paymentTransaction.findMany(),
        orderEvents: await db.$queryRaw`SELECT * FROM OrderEvent ORDER BY id`,
        subscriptionEvents:
          await db.$queryRaw`SELECT * FROM SubscriptionEvent ORDER BY id`,
        audits: await db.$queryRaw`SELECT * FROM AdminAuditLog ORDER BY id`,
        settings: await db.$queryRaw`SELECT * FROM AppSettings ORDER BY id`,
      },
      (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    ),
  )
}
function assertRecordsUnchanged(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  // Compare complete records without dumping password/token hashes on a failure.
  for (const [table, rows] of Object.entries(expected))
    assert(
      isDeepStrictEqual(actual[table], rows),
      'Upgrade changed existing ' + table + ' records',
    )
}
try {
  if (process.argv[2] === 'before') {
    assert.equal(await db.user.count(), 0)
    const admin = { id: randomUUID(), loginEmail: 'upgrade-admin@example.com' }
    const user = {
      id: randomUUID(),
      loginEmail: 'upgrade-customer@example.com',
    }
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD)
    await db.$executeRaw`INSERT INTO User (id,displayName,loginEmail,role,status,passwordHash,activatedAt,updatedAt) VALUES (${admin.id},'Upgrade fixture administrator',${admin.loginEmail},'ADMIN','ACTIVE',${passwordHash},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`
    await db.$executeRaw`INSERT INTO User (id,displayName,loginEmail,createdByAdminId,updatedAt) VALUES (${user.id},'Pending legacy customer',${user.loginEmail},${admin.id},UTC_TIMESTAMP(3))`
    const productId = randomUUID()
    await db.$executeRaw`INSERT INTO Product (id,slug,name,type,priceFen,renewalPriceFen,termLabel,targetField,listed,purchaseEnabled,renewalEnabled,updatedAt) VALUES (${productId},'legacy-product','Legacy product','SUBSCRIPTION',1234,999,'Legacy confirmed term','EMAIL',true,false,true,UTC_TIMESTAMP(3))`
    // An old archived-but-listed row must be normalized without losing its history.
    await db.$executeRaw`INSERT INTO Product (id,slug,name,type,priceFen,termLabel,targetField,listed,purchaseEnabled,renewalEnabled,archivedAt,updatedAt) VALUES (${randomUUID()},'legacy-archived','Archived legacy product','ONE_TIME',500,'Once','NONE',true,true,false,'2026-01-01 00:00:00.000',UTC_TIMESTAMP(3))`
    // The current generated client has columns that do not exist in this old schema.
    const order = { id: randomUUID() }
    await db.$executeRaw`INSERT INTO \`Order\` (id,orderNo,userId,productId,kind,productNameSnapshot,productTypeSnapshot,termSnapshot,amountFen,renewalPriceSnapshotFen,contactEmailSnapshot,targetIdentifier,createdByAdminId,updatedAt) VALUES (${order.id},'UPGRADE-ORDER',${user.id},${productId},'INITIAL','Historical name','SUBSCRIPTION','Historical term',1234,999,${user.loginEmail},'legacy@example.com',${admin.id},UTC_TIMESTAMP(3))`
    for (const [payment, fulfillment] of [
      ['PAID', 'COMPLETED'],
      ['REFUNDED', 'CANCELLED'],
    ] as const) {
      await db.$executeRaw`INSERT INTO \`Order\` (id,orderNo,userId,productId,kind,productNameSnapshot,productTypeSnapshot,termSnapshot,amountFen,contactEmailSnapshot,createdByAdminId,paymentStatus,fulfillmentStatus,updatedAt) VALUES (${randomUUID()},${'UPGRADE-' + payment},${user.id},${productId},'INITIAL','Historical paid/cancelled name','SUBSCRIPTION','30 days legacy text',1234,${user.loginEmail},${admin.id},${payment},${fulfillment},UTC_TIMESTAMP(3))`
    }
    const sub = { id: randomUUID() }
    await db.$executeRaw`INSERT INTO Subscription (id,userId,productId,sourceType,targetIdentifier,startedAt,expiresAt,renewalPriceFen,createdByAdminId,updatedAt) VALUES (${sub.id},${user.id},${productId},'MANUAL_GRANT','legacy@example.com','2026-01-01','2030-01-01',999,${admin.id},UTC_TIMESTAMP(3))`
    for (const source of ['ORDER', 'HISTORICAL_IMPORT']) {
      const sourceOrderId = source === 'ORDER' ? order.id : null
      await db.$executeRaw`INSERT INTO Subscription (id,userId,productId,sourceType,sourceOrderId,targetIdentifier,startedAt,expiresAt,renewalPriceFen,status,createdByAdminId,updatedAt) VALUES (${randomUUID()},${user.id},${productId},${source},${sourceOrderId},'preserved-legacy','2026-01-01','2030-01-01',0,'TERMINATED',${admin.id},UTC_TIMESTAMP(3))`
    }
    await db.paymentTransaction.create({
      data: {
        orderId: order.id,
        kind: 'PAYMENT',
        channel: 'CASH',
        amountFen: 1234,
        occurredAt: new Date(),
        createdByAdminId: admin.id,
      },
    })
    await db.$executeRaw`INSERT INTO OrderEvent (id,orderId,eventType,actorAdminId) VALUES (${randomUUID()},${order.id},'ORDER_CREATED',${admin.id})`
    await db.$executeRaw`INSERT INTO SubscriptionEvent (id,subscriptionId,eventType,actorAdminId,reason) VALUES (${randomUUID()},${sub.id},'MANUAL_GRANT',${admin.id},'Legacy event retained')`
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: tokenHash('u'.repeat(43)),
        expiresAt: new Date('2030-01-01'),
      },
    })
    await db.invitationToken.create({
      data: {
        userId: user.id,
        createdByAdminId: admin.id,
        tokenHash: tokenHash('upgrade-invitation'),
        expiresAt: new Date('2030-01-01'),
      },
    })
    await db.$executeRaw`INSERT INTO AdminAuditLog (id,actorAdminId,action,entityType,entityId) VALUES (${randomUUID()},${admin.id},'UPGRADE_FIXTURE','User',${user.id})`
    await db.$executeRaw`INSERT INTO AppSettings (id,storeName,ownerEmail,timezone,updatedAt) VALUES (1,'Existing store','upgrade-admin@example.com','Asia/Shanghai',UTC_TIMESTAMP(3))`
    writeFileSync(snapshotFile, JSON.stringify(await snapshot()), {
      mode: 0o600,
    })
  } else if (process.argv[2] === 'forms') {
    // The already-committed form migration must preserve all original data.
    assertRecordsUnchanged(
      await snapshot(),
      JSON.parse(readFileSync(snapshotFile, 'utf8')),
    )
    for (const p of await db.product.findMany({
      select: { formSchema: true, sortOrder: true },
    })) {
      assert.deepEqual(p.formSchema, { version: 1, fields: [] })
      assert.equal(p.sortOrder, 0)
    }
    // Model a PR #4 installation with saved forms before applying the review migration.
    await db.product.update({
      where: { slug: 'legacy-product' },
      select: { id: true },
      data: {
        sortOrder: 17,
        formSchema: {
          version: 1,
          fields: [
            {
              id: 'legacy_contact',
              type: 'email',
              label: 'Contact',
              required: true,
              hint: 'Non-sensitive contact',
              defaultValue: 'contact@example.com',
            },
          ],
        },
      },
    })
    const expected = await snapshot()
    for (const p of expected.products) if (p.archivedAt !== null) p.listed = 0
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        records: expected,
        forms: await db.product.findMany({
          select: { id: true, formSchema: true, sortOrder: true },
          orderBy: { id: 'asc' },
        }),
      }),
      { mode: 0o600 },
    )
  } else if (process.argv[2] === 'guard') {
    const rows = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM Subscription ORDER BY id LIMIT 1`
    const id = rows[0]!.id
    const previous = await db.$queryRaw<
      { status: string }[]
    >`SELECT status FROM Subscription WHERE id = ${id}`
    await db.$executeRaw`UPDATE Subscription SET status = 'SUSPENDED' WHERE id = ${id}`
    const paused = await snapshot()
    await assert.rejects(
      migrationPreflight(db),
      (error: unknown) =>
        error instanceof SuspendedMigrationError &&
        error.ids.length === 1 &&
        error.ids[0] === id &&
        error.message.includes('1 SUSPENDED'),
    )
    const guardSql = readFileSync(
      new URL(
        '../../prisma/migrations/20261117030000_user_subscription_core/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )
      .split(';')
      .slice(0, 2)
    await assert.rejects(
      db.$transaction(async (tx) => {
        for (const statement of guardSql) await tx.$executeRawUnsafe(statement)
      }),
    )
    await db.$executeRawUnsafe(
      'DROP TEMPORARY TABLE IF EXISTS _phase2_suspended_guard',
    )
    assertRecordsUnchanged(await snapshot(), paused)
    await db.$executeRaw`UPDATE Subscription SET status = ${previous[0]!.status} WHERE id = ${id}`
    console.info(
      'SUSPENDED preflight reports count/ID and leaves every row unchanged.',
    )
  } else if (process.argv[2] === 'after') {
    const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    const actual = await snapshot()
    for (const row of expected.records.users) {
      row.adminLabel = row.displayName
      delete row.displayName
    }
    for (const row of expected.records.subscriptions) row.sourceType = 'ADMIN'
    // Compare all original columns, including password hashes/FKs/timestamps, without
    // dumping private values. The new columns are verified separately below.
    const projected: Record<string, unknown> = {}
    for (const [table, rows] of Object.entries(expected.records) as [
      string,
      Record<string, unknown>[],
    ][]) {
      const actualRows = actual[table] as Record<string, unknown>[]
      assert.equal(actualRows.length, rows.length, table + ' row count changed')
      projected[table] = actualRows.map((row) =>
        Object.fromEntries(
          Object.keys(rows[0] ?? {}).map((key) => [key, row[key]]),
        ),
      )
    }
    assertRecordsUnchanged(projected, expected.records)
    for (const user of await db.user.findMany())
      assert.equal(user.username, null)
    for (const sub of await db.subscription.findMany({
      include: { product: true },
    })) {
      assert.equal(sub.version, 1)
      assert.equal(sub.sourceType, 'ADMIN')
      assert.equal(sub.productNameSnapshot, sub.product.name)
      assert.deepEqual(sub.formSchemaSnapshot, sub.product.formSchema)
      assert.deepEqual(sub.formData, {})
    }
    const auth = authService(db)
    assert(
      await auth.resolve('u'.repeat(43)),
      'Existing session must survive migration',
    )
    assert(
      (
        await auth.login(
          'upgrade-admin@example.com',
          env.ADMIN_PASSWORD,
          'upgrade-login',
        )
      ).user.role === 'ADMIN',
    )
    // Remove only the additional audit/session records made by this isolated login.
    await db.session.deleteMany({
      where: { tokenHash: { not: tokenHash('u'.repeat(43)) } },
    })
    await db.adminAuditLog.deleteMany({ where: { action: 'ADMIN_LOGGED_IN' } })
    assert.deepEqual(
      await db.product.findMany({
        select: { id: true, formSchema: true, sortOrder: true },
        orderBy: { id: 'asc' },
      }),
      expected.forms,
    )
    const columns = await db.$queryRaw<
      { name: string }[]
    >`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'`
    assert(
      !columns.some((c) =>
        ['purchaseEnabled', 'renewalEnabled'].includes(c.name),
      ),
    )
    const product = await db.product.findUniqueOrThrow({
      where: { slug: 'legacy-product' },
    })
    assert.equal(product.targetField, 'EMAIL')
    const archived = await db.product.findUniqueOrThrow({
      where: { slug: 'legacy-archived' },
    })
    assert.equal(archived.listed, false)
    assert(archived.archivedAt)
    assert.deepEqual(archived.formSchema, { version: 1, fields: [] })
    assert.equal(
      (
        await db.user.findUniqueOrThrow({
          where: { loginEmail: 'upgrade-customer@example.com' },
        })
      ).status,
      'PENDING_ACTIVATION',
    )
    // Keep protected legacy orders and all related fixtures. Only removal of this
    // runner's random disposable project cleans them up; never disable triggers.
    console.info(
      'Upgrade preserved all 11 populated legacy tables, source links, dates, forms, sessions and invitations; mapped legacy sources to ADMIN and added immutable subscription snapshots.',
    )
  } else
    throw new Error('Expected before/forms/guard/after upgrade fixture mode.')
} finally {
  await db.$disconnect()
}
