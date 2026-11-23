import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import type { Prisma } from '../generated/prisma/client.ts'

export class BootstrapMigrationError extends Error {
  constructor() {
    super(
      'Production bootstrap requires the explicitly selected database and the complete release migration history. Verify migration status before retrying.',
    )
    this.name = 'BootstrapMigrationError'
  }
}

export function releaseMigrations() {
  const directory = new URL('../../prisma/migrations/', import.meta.url)
  const migrations = new Map<string, Set<string>>()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sql = readFileSync(
      new URL(entry.name + '/migration.sql', directory),
      'utf8',
    )
    const lf = sql.replaceAll('\r\n', '\n')
    // Prisma migration history may have been recorded by a CRLF checkout.
    migrations.set(
      entry.name,
      new Set(
        [sql, lf, lf.replaceAll('\n', '\r\n')].map((text) =>
          createHash('sha256').update(text).digest('hex'),
        ),
      ),
    )
  }
  if (!migrations.size) throw new BootstrapMigrationError()
  return migrations
}

export async function verifyBootstrapTarget(
  tx: Prisma.TransactionClient,
  name: string,
  migrations: ReturnType<typeof releaseMigrations>,
) {
  const [target] = await tx.$queryRaw<
    { name: string }[]
  >`SELECT DATABASE() AS name`
  if (target?.name !== name) throw new BootstrapMigrationError()
  const [history] = await tx.$queryRaw<{ present: number | bigint }[]>`
    SELECT COUNT(*) AS present FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = '_prisma_migrations'
  `
  if (!Number(history?.present)) throw new BootstrapMigrationError()
  const recorded = await tx.$queryRaw<
    {
      migration_name: string
      checksum: string
      finished_at: Date | null
      rolled_back_at: Date | null
    }[]
  >`
    SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM _prisma_migrations
  `
  if (
    recorded.length !== migrations.size ||
    new Set(recorded.map((entry) => entry.migration_name)).size !==
      migrations.size ||
    recorded.some(
      (entry) =>
        !entry.finished_at ||
        entry.rolled_back_at ||
        !migrations.get(entry.migration_name)?.has(entry.checksum),
    )
  )
    throw new BootstrapMigrationError()
}
