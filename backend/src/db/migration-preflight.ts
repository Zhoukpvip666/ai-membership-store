import type { PrismaClient } from '../generated/prisma/client.ts'

export class SuspendedMigrationError extends Error {
  readonly ids: string[]
  constructor(ids: string[]) {
    super(
      `Migration blocked: ${ids.length} SUSPENDED subscriptions. IDs: ${ids.join(', ')}. No automatic status change; operator decision required.`,
    )
    this.ids = ids
  }
}

export async function migrationPreflight(database: PrismaClient) {
  const tables = await database.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Subscription'`
  if (Number(tables[0]?.n) === 0) return
  const rows = await database.$queryRaw<{ id: string }[]>`
    SELECT id FROM Subscription WHERE status = 'SUSPENDED' ORDER BY id`
  if (rows.length) throw new SuspendedMigrationError(rows.map((row) => row.id))
}
