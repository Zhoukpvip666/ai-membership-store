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

export class CustomerCredentialsMigrationError extends Error {
  constructor(count: number) {
    super(
      'Migration blocked: ' +
        count +
        ' ACTIVE accounts have missing or invalid login credentials or activation time. No account was changed.',
    )
    this.name = 'CustomerCredentialsMigrationError'
  }
}

export async function migrationPreflight(database: PrismaClient) {
  const tables = await database.$queryRaw<{ tableName: string }[]>`
    SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('Subscription', 'User')`
  if (tables.some((row) => row.tableName === 'Subscription')) {
    const rows = await database.$queryRaw<{ id: string }[]>`
      SELECT id FROM Subscription WHERE status = 'SUSPENDED' ORDER BY id`
    if (rows.length)
      throw new SuspendedMigrationError(rows.map((row) => row.id))
  }
  if (!tables.some((row) => row.tableName === 'User')) return

  const [accounts] = await database.$queryRaw<
    {
      total: bigint
      invalidActive: bigint
      cleanup: bigint
      unclassified: bigint
    }[]
  >`
    SELECT COUNT(*) AS total,
      COUNT(CASE WHEN profile.status = 'ACTIVE' AND
        (profile.loginEmail IS NULL
         OR NOT REGEXP_LIKE(profile.loginEmail, '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
         OR profile.passwordHash IS NULL OR CHAR_LENGTH(TRIM(profile.passwordHash)) = 0
         OR profile.activatedAt IS NULL)
        THEN 1 END) AS invalidActive,
      COUNT(CASE WHEN profile.role = 'CUSTOMER' AND profile.status IN ('PENDING_ACTIVATION', 'DISABLED')
        AND profile.activatedAt IS NULL AND profile.passwordHash IS NULL AND creator.id IS NOT NULL
        AND (profile.loginEmail IS NOT NULL OR profile.notificationEmail IS NOT NULL)
        THEN 1 END) AS cleanup,
      COUNT(CASE WHEN profile.role = 'CUSTOMER' AND profile.status IN ('PENDING_ACTIVATION', 'DISABLED')
        AND ((profile.status = 'PENDING_ACTIVATION' AND
            (profile.activatedAt IS NOT NULL OR profile.passwordHash IS NOT NULL))
          OR (profile.activatedAt IS NULL AND profile.passwordHash IS NOT NULL)
          OR (profile.activatedAt IS NOT NULL AND (profile.passwordHash IS NULL OR profile.loginEmail IS NULL))
          OR (profile.activatedAt IS NULL AND profile.passwordHash IS NULL AND creator.id IS NULL
            AND (profile.loginEmail IS NOT NULL OR profile.notificationEmail IS NOT NULL)))
        THEN 1 END) AS unclassified
    FROM User AS profile
    LEFT JOIN User AS creator ON creator.id = profile.createdByAdminId AND creator.role = 'ADMIN'`
  if (Number(accounts.invalidActive))
    throw new CustomerCredentialsMigrationError(Number(accounts.invalidActive))
  return {
    total: Number(accounts.total),
    cleanup: Number(accounts.cleanup),
    unclassified: Number(accounts.unclassified),
  }
}
