// Populated tenth -> eleventh migration, exclusively in the runner's random DB.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { mutation } from '../../src/modules/subscriptions/idempotency.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)
const file = process.argv[3]!
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  )
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
try {
  if (process.argv[2] === 'before') {
    const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
    const customer = await db.user.create({
      data: { loginEmail: 'revision-upgrade@example.com' },
    })
    const product = await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Upgrade fixture',
        type: 'ONE_TIME',
        priceFen: 123,
        termLabel: 'Unknown historical display',
      },
    })
    const orderId = randomUUID()
    // New Client already knows version, but migration ten does not. Use old SQL.
    await db.$executeRaw`INSERT INTO \`Order\` (id,orderNo,userId,productId,kind,source,createdByAdminId,productNameSnapshot,productTypeSnapshot,termSnapshot,amountFen,contactEmailSnapshot,internalNote,updatedAt) VALUES (${orderId},${randomUUID()},${customer.id},${product.id},'ONE_TIME','ADMIN',${admin.id},'Frozen historical name','ONE_TIME','Do not infer a period',123,${customer.loginEmail},'Retain historical note',UTC_TIMESTAMP(3))`
    await db.paymentTransaction.create({
      data: {
        orderId,
        kind: 'PAYMENT',
        channel: 'CASH',
        amountFen: 123,
        occurredAt: new Date(),
        createdByAdminId: admin.id,
      },
    })
    await db.orderEvent.create({
      data: { orderId, eventType: 'ORDER_CREATED', actorAdminId: admin.id },
    })
    const subscription = await db.subscription.create({
      data: {
        userId: customer.id,
        productId: product.id,
        sourceType: 'ADMIN',
        createdByAdminId: admin.id,
        productNameSnapshot: 'Unlinked legacy subscription',
        productTypeSnapshot: 'SUBSCRIPTION',
        priceSnapshotFen: 123,
        termSnapshot: 'Unknown',
        startedAt: new Date('2020-01-01Z'),
        expiresAt: new Date('2099-01-01Z'),
        renewalPriceFen: 123,
      },
    })
    await db.subscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        eventType: 'CREATED',
        actorAdminId: admin.id,
      },
    })
    await db.adminAuditLog.create({
      data: {
        actorAdminId: admin.id,
        action: 'REVISION_UPGRADE_FIXTURE',
        entityType: 'Order',
        entityId: orderId,
      },
    })
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: hash(randomUUID()),
        expiresAt: new Date('2099-01-01Z'),
      },
    })
    await db.invitationToken.create({
      data: {
        userId: customer.id,
        tokenHash: hash(randomUUID()),
        expiresAt: new Date('2099-01-01Z'),
        createdByAdminId: admin.id,
      },
    })
    const key = randomUUID(),
      id = randomUUID(),
      operation = 'SUBSCRIPTION_CREATE'
    const input = { legacy: true }
    const response = {
      subscription: { id: subscription.id, version: 1 },
      preserved: true,
    }
    const requestHash = hash(JSON.stringify({ input, operation }))
    await db.$executeRaw`INSERT INTO IdempotencyRecord (id,actorAdminId,keyHash,requestHash,operation,responseJson) VALUES (${id},${admin.id},${hash(key)},${requestHash},${operation},${JSON.stringify(response)})`
    const records = json(await businessSnapshot(db))
    for (const rows of Object.values(records))
      assert((rows as unknown[]).length > 0)
    writeFileSync(
      file,
      JSON.stringify({
        records,
        key,
        operation,
        input,
        response,
        actorId: admin.id,
      }),
      { mode: 0o600 },
    )
  } else {
    const expected = JSON.parse(readFileSync(file, 'utf8'))
    const before = expected.records
    for (const order of before.Order) order.version = 1
    for (const record of before.IdempotencyRecord) {
      record.actorUserId = record.actorAdminId
      delete record.actorAdminId
    }
    const actual = json(await businessSnapshot(db))
    assert(
      isDeepStrictEqual(actual, before),
      'Migration changed pre-existing business values or rows',
    )
    assert.equal(
      await db.orderRevision.count(),
      0,
      'No fabricated historical revisions',
    )
    assert.equal(
      await db.order.count({ where: { version: 1 } }),
      before.Order.length,
    )
    const replay = await mutation(
      db,
      expected.actorId,
      expected.key,
      expected.operation,
      expected.input,
      async () => {
        throw new Error('Historical replay executed action')
      },
    )
    assert.deepEqual(replay, expected.response)
    await assert.rejects(
      mutation(
        db,
        expected.actorId,
        expected.key,
        'OTHER_OPERATION',
        expected.input,
        async () => ({}),
      ),
      (e: unknown) => (e as { status?: number }).status === 409,
    )
    assert(
      isDeepStrictEqual(json(await businessSnapshot(db)), before),
      'Historical replay wrote data',
    )
    console.info(
      'All twelve populated business tables retained byte-equivalent values; only Order.version=1 and actor column name changed. Historical hashes/responses replay unchanged; no revisions fabricated.',
    )
  }
} finally {
  await db.$disconnect()
}
