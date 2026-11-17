// This fixture runs only inside the random disposable test database.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { hashPassword, tokenHash } from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const snapshotFile = process.argv[3]!
async function snapshot() {
  return JSON.parse(
    JSON.stringify(
      {
        users: await db.user.findMany({ orderBy: { id: 'asc' } }),
        sessions: await db.session.findMany(),
        invitations: await db.invitationToken.findMany(),
        products:
          await db.$queryRaw`SELECT id,slug,name,description,type,priceFen,renewalPriceFen,termLabel,targetField,listed,archivedAt,createdAt,updatedAt FROM Product ORDER BY id`,
        orders: await db.order.findMany(),
        subscriptions: await db.subscription.findMany(),
        payments: await db.paymentTransaction.findMany(),
        orderEvents: await db.orderEvent.findMany(),
        subscriptionEvents: await db.subscriptionEvent.findMany(),
        audits: await db.adminAuditLog.findMany(),
        settings: await db.appSettings.findMany(),
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
    const admin = await db.user.create({
      data: {
        displayName: 'Upgrade fixture administrator',
        loginEmail: 'upgrade-admin@example.com',
        role: 'ADMIN',
        status: 'ACTIVE',
        passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      },
    })
    const user = await db.user.create({
      data: {
        displayName: 'Pending legacy customer',
        loginEmail: 'upgrade-customer@example.com',
        createdByAdminId: admin.id,
      },
    })
    const productId = randomUUID()
    await db.$executeRaw`INSERT INTO Product (id,slug,name,type,priceFen,renewalPriceFen,termLabel,targetField,listed,purchaseEnabled,renewalEnabled,updatedAt) VALUES (${productId},'legacy-product','Legacy product','SUBSCRIPTION',1234,999,'Legacy confirmed term','EMAIL',true,false,true,UTC_TIMESTAMP(3))`
    // An old archived-but-listed row must be normalized without losing its history.
    await db.$executeRaw`INSERT INTO Product (id,slug,name,type,priceFen,termLabel,targetField,listed,purchaseEnabled,renewalEnabled,archivedAt,updatedAt) VALUES (${randomUUID()},'legacy-archived','Archived legacy product','ONE_TIME',500,'Once','NONE',true,true,false,'2026-01-01 00:00:00.000',UTC_TIMESTAMP(3))`
    const order = await db.order.create({
      data: {
        orderNo: 'UPGRADE-ORDER',
        userId: user.id,
        productId,
        kind: 'INITIAL',
        productNameSnapshot: 'Historical name',
        productTypeSnapshot: 'SUBSCRIPTION',
        termSnapshot: 'Historical term',
        amountFen: 1234,
        renewalPriceSnapshotFen: 999,
        contactEmailSnapshot: user.loginEmail,
        targetIdentifier: 'legacy@example.com',
        createdByAdminId: admin.id,
      },
    })
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        productId,
        sourceType: 'MANUAL_GRANT',
        targetIdentifier: 'legacy@example.com',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-12-01T00:00:00Z'),
        renewalPriceFen: 999,
        createdByAdminId: admin.id,
      },
    })
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
    await db.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: 'ORDER_CREATED',
        actorAdminId: admin.id,
      },
    })
    await db.subscriptionEvent.create({
      data: {
        subscriptionId: sub.id,
        eventType: 'MANUAL_GRANT',
        actorAdminId: admin.id,
      },
    })
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: tokenHash('upgrade-session'),
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
    await db.adminAuditLog.create({
      data: {
        actorAdminId: admin.id,
        action: 'UPGRADE_FIXTURE',
        entityType: 'User',
        entityId: user.id,
      },
    })
    await db.appSettings.create({
      data: {
        id: 1,
        storeName: 'Existing store',
        ownerEmail: 'upgrade-admin@example.com',
        timezone: 'Asia/Shanghai',
      },
    })
    writeFileSync(snapshotFile, JSON.stringify(await snapshot()), {
      mode: 0o600,
    })
  } else if (process.argv[2] === 'forms') {
    // The already-committed form migration must preserve all original data.
    assertRecordsUnchanged(
      await snapshot(),
      JSON.parse(readFileSync(snapshotFile, 'utf8')),
    )
    for (const p of await db.product.findMany()) {
      assert.deepEqual(p.formSchema, { version: 1, fields: [] })
      assert.equal(p.sortOrder, 0)
    }
    // Model a PR #4 installation with saved forms before applying the review migration.
    await db.product.update({
      where: { slug: 'legacy-product' },
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
  } else if (process.argv[2] === 'after') {
    const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    assertRecordsUnchanged(await snapshot(), expected.records)
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
    // Remove only the known fictional upgrade fixture before the existing empty-db suite.
    await db.$transaction(async (tx) => {
      await tx.subscriptionEvent.deleteMany()
      await tx.orderEvent.deleteMany()
      await tx.paymentTransaction.deleteMany()
      await tx.subscription.deleteMany()
      await tx.order.deleteMany()
      await tx.session.deleteMany()
      await tx.invitationToken.deleteMany()
      await tx.adminAuditLog.deleteMany()
      await tx.product.deleteMany({
        where: { id: { in: [product.id, archived.id] } },
      })
      await tx.appSettings.delete({ where: { id: 1 } })
      await tx.user.delete({
        where: { loginEmail: 'upgrade-customer@example.com' },
      })
      await tx.user.delete({
        where: { loginEmail: 'upgrade-admin@example.com' },
      })
    })
    console.info(
      'Upgrade preserved all 11 populated business tables and saved forms/sort values; removed only obsolete permission columns and unlisted archived products.',
    )
  } else throw new Error('Expected before/forms/after upgrade fixture mode.')
} finally {
  await db.$disconnect()
}
