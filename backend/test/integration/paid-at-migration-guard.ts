// Only the random runner-owned database: verify rejection without altering business tables.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)
const sixth = readFileSync(
  new URL(
    '../../prisma/migrations/20261118010000_order_subscription_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const seventh = readFileSync(
  new URL(
    '../../prisma/migrations/20261118020000_order_paid_at/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const oldCheck = sixth.match(
  /ADD CONSTRAINT `Order_system_renewal_final_check` CHECK \(([\s\S]*?)\n {4}\);/,
)
assert(oldCheck?.[1], 'Expected the unchanged sixth-migration check.')

try {
  // This small scratch table has only the columns read by the real migration.
  // Reuse the exact sixth CHECK and seventh ALTER, changing only identifiers.
  await db.$executeRawUnsafe(`CREATE TABLE _paid_at_guard (
    id VARCHAR(36) PRIMARY KEY,
    source VARCHAR(40) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    hidden BOOLEAN NOT NULL,
    subscriptionId VARCHAR(36) NULL,
    paymentStatus VARCHAR(40) NOT NULL,
    fulfillmentStatus VARCHAR(40) NOT NULL,
    paymentRecordedAt DATETIME(3) NULL,
    paymentConfirmedAt DATETIME(3) NULL,
    fulfilledAt DATETIME(3) NULL,
    cancelledAt DATETIME(3) NULL,
    CONSTRAINT _paid_at_guard_final CHECK (${oldCheck[1]})
  ) ENGINE=InnoDB`)
  await db.$executeRaw`INSERT INTO _paid_at_guard
    (id,source,kind,hidden,subscriptionId,paymentStatus,fulfillmentStatus,paymentRecordedAt,paymentConfirmedAt,fulfilledAt)
    VALUES ('sixth-only-fixture','SYSTEM_RENEWAL','RENEWAL',true,'fixture-subscription','PAID','COMPLETED','2026-11-01 10:00:00','2026-11-01 10:01:00','2026-11-01 10:02:00')`
  const before = await db.$queryRaw`SELECT * FROM _paid_at_guard`
  const beforeCheck =
    await db.$queryRaw`SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = '_paid_at_guard_final'`
  const repair = seventh
    .replaceAll('`Order`', '`_paid_at_guard`')
    .replaceAll('`Order_system_renewal_final_check`', '`_paid_at_guard_final`')
    .replaceAll('`Order_payment_timeline_check`', '`_paid_at_guard_timeline`')
  await assert.rejects(db.$executeRawUnsafe(repair), (error: unknown) =>
    /_paid_at_guard_final/.test(String(error)),
  )
  assert.deepEqual(await db.$queryRaw`SELECT * FROM _paid_at_guard`, before)
  assert.deepEqual(
    await db.$queryRaw`SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = '_paid_at_guard_final'`,
    beforeCheck,
  )
  const columns = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_paid_at_guard' AND COLUMN_NAME = 'paidAt'`
  assert.equal(
    Number(columns[0]?.n),
    0,
    'Failed ALTER must leave the old table intact.',
  )
  console.info(
    'Paid-at migration guard: existing system renewal with unknown actual payment time is rejected; old row/check/columns preserved, no backfill or trigger disabling.',
  )
} finally {
  // Only this scratch table in the guarded disposable DB; never the real Order table.
  await db.$executeRawUnsafe('DROP TABLE IF EXISTS _paid_at_guard')
  await db.$disconnect()
}
