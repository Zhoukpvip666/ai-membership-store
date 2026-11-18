// Runs only in the disposable database created by scripts/test-database.ts.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const snapshotFile = process.argv[3]!
const tables = [
  'User',
  'Product',
  'Order',
  'PaymentTransaction',
  'OrderEvent',
  'Subscription',
  'SubscriptionEvent',
  'AdminAuditLog',
  'Session',
  'InvitationToken',
  'AppSettings',
  'IdempotencyRecord',
] as const
type Records = Record<string, Record<string, unknown>[]>
async function snapshot(): Promise<Records> {
  const result: Records = {}
  for (const table of tables) {
    // Identifiers come exclusively from the fixed whitelist above.
    result[table] = JSON.parse(
      JSON.stringify(
        await db.$queryRawUnsafe(`SELECT * FROM \`${table}\` ORDER BY id`),
        (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      ),
    )
  }
  return result
}

try {
  if (process.argv[2] === 'before') {
    const [admin] = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM User WHERE role = 'ADMIN'`
    const id = randomUUID()
    await db.$executeRaw`INSERT INTO IdempotencyRecord (id,actorAdminId,keyHash,requestHash,operation,responseJson) VALUES (${id},${admin!.id},${'a'.repeat(64)},${'b'.repeat(64)},'UPGRADE_FIXTURE',JSON_OBJECT('preserved',true))`
    // An old recording timestamp and a real transaction are NOT grounds to infer paidAt.
    // This script runs against migration six, so use raw SQL without the new client column.
    await db.$executeRaw`UPDATE \`Order\` o JOIN PaymentTransaction p ON p.orderId = o.id SET o.paymentRecordedAt = p.createdAt WHERE o.source = 'OFFLINE_MANUAL'`
    const records = await snapshot()
    for (const table of tables)
      assert(records[table]!.length > 0, table + ' fixture missing')
    writeFileSync(snapshotFile, JSON.stringify({ id, records }), {
      mode: 0o600,
    })
  } else if (process.argv[2] === 'after') {
    const expected = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
      id: string
      records: Records
    }
    const actual = await snapshot()
    for (const table of tables) {
      const oldRows = expected.records[table]!
      assert.equal(
        actual[table]!.length,
        oldRows.length,
        table + ' row count changed',
      )
      const projected = actual[table]!.map((row) =>
        Object.fromEntries(
          Object.keys(oldRows[0]!).map((column) => [column, row[column]]),
        ),
      )
      // Never print credentials, hashes, or historic form contents on assertion failure.
      assert(
        isDeepStrictEqual(projected, oldRows),
        table + ' legacy data changed',
      )
    }
    for (const product of actual.Product!) {
      assert.equal(product.servicePeriodUnit, null)
      assert.equal(product.servicePeriodCount, null)
    }
    for (const order of actual.Order!) {
      assert.equal(order.source, 'OFFLINE_MANUAL')
      assert.equal(order.hidden, 0)
      for (const column of [
        'productDescriptionSnapshot',
        'priceSnapshotFen',
        'servicePeriodUnitSnapshot',
        'servicePeriodCountSnapshot',
        'formSchemaSnapshot',
        'formData',
        'paidAt',
        'paymentConfirmedAt',
        'fulfilledAt',
        'cancelledAt',
        'cancellationReason',
        'createdByUserId',
        'renewalPeriodStartAt',
        'renewalPeriodEndAt',
        'renewalForPeriodStartAt',
        'billingAnchorSnapshotAt',
        'billingTimezoneSnapshot',
        'billingRevisionSnapshot',
        'renewalRequestKeyHash',
        'renewalRequestHash',
      ])
        assert.equal(
          order[column],
          null,
          'Historic order field must remain unknown: ' + column,
        )
    }
    for (const sub of actual.Subscription!) {
      for (const column of [
        'servicePeriodUnitSnapshot',
        'servicePeriodCountSnapshot',
        'billingAnchorAt',
        'billingTimezone',
        'billingRevision',
        'earlyRenewalUsed',
        'currentPeriodStartAt',
        'currentPeriodEndAt',
        'earlyRenewedPeriodStartAt',
        'earlyRenewalOrderId',
      ])
        assert.equal(
          sub[column],
          null,
          'Historic subscription field must remain unknown: ' + column,
        )
    }
    for (const event of actual.OrderEvent!) {
      assert.equal(event.actorType, 'ADMIN')
      assert.equal(event.actorUserId, null)
    }
    assert.equal(actual.AppSettings![0]!.paymentInstructions, '')
    // Leave the original eleven-table fixture for its independent legacy checks/cleanup.
    await db.idempotencyRecord.delete({ where: { id: expected.id } })
    console.info(
      'Paid-at migration preserved every old column in all 12 populated business tables; historical paidAt stays NULL despite existing transactions/entry timestamps, no actual payment times fabricated.',
    )
  } else throw new Error('Expected before/after order upgrade mode.')
} finally {
  await db.$disconnect()
}
