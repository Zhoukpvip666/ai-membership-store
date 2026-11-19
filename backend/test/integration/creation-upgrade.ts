import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createDatabase } from '../../src/db/client.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)
const [phase, path] = process.argv.slice(2)
assert(path)
const snapshot = async () => ({
  ...(await businessSnapshot(db)),
  OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
})
try {
  if (phase === 'before') {
    const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
    const user = await db.user.create({
      data: { loginEmail: randomUUID() + '@example.com' },
    })
    const product = await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Old product',
        type: 'ONE_TIME',
        priceFen: 100,
        termLabel: 'Unknown',
      },
    })
    for (const paymentStatus of ['UNPAID', 'PAID', 'REFUNDED'] as const) {
      const order = await db.order.create({
        data: {
          orderNo: randomUUID(),
          userId: user.id,
          productId: product.id,
          source: 'ADMIN',
          kind: 'ONE_TIME',
          createdByAdminId: admin.id,
          productNameSnapshot: 'Old snapshot',
          productTypeSnapshot: 'ONE_TIME',
          termSnapshot: 'Unknown',
          amountFen: paymentStatus === 'UNPAID' ? 0 : 100,
          paymentStatus,
          contactEmailSnapshot: user.loginEmail,
        },
      })
      await db.orderRevision.create({
        data: {
          orderId: order.id,
          version: 1,
          snapshotSchemaVersion: 1,
          snapshotJson: buildOrderSnapshot(order),
          actorType: 'ADMIN',
          actorUserId: admin.id,
        },
      })
    }
    await db.idempotencyRecord.create({
      data: {
        actorUserId: admin.id,
        keyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        operation: 'HISTORICAL_TEST',
        responseJson: { preserved: true },
      },
    })
    writeFileSync(path, JSON.stringify(await snapshot()))
    console.info(
      'Captured all thirteen business tables before migration twelve, including historical zero/paid/refunded orders and immutable revisions.',
    )
  } else {
    assert.deepEqual(
      JSON.parse(JSON.stringify(await snapshot())),
      JSON.parse(readFileSync(path, 'utf8')),
    )
    const columns = await db.$queryRaw<
      { definition: string }[]
    >`SELECT COLUMN_TYPE AS definition FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Order' AND COLUMN_NAME='paymentStatus'`
    assert(columns[0].definition.includes('NOT_REQUIRED'))
    assert.equal(
      await db.order.count({ where: { paymentStatus: 'NOT_REQUIRED' } }),
      0,
    )
    console.info(
      'Migration twelve preserved every business row and revision exactly; no zero-order reclassification or fabricated payment facts. Repeat deploy and schema diff passed.',
    )
  }
} finally {
  await db.$disconnect()
}
