import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  migrationPreflight,
  SuspendedMigrationError,
} from '../src/db/migration-preflight.ts'
import {
  parseMigrationEnvironment,
  requireProductionMode,
  EnvironmentError,
} from '../src/config/env.ts'

const require = createRequire(import.meta.url)
const explicitProduction = process.argv.includes('--production')
const args = process.argv.slice(2).filter((arg) => arg !== '--production')
try {
  const offline =
    ['generate', 'validate', 'format'].includes(args[0] ?? '') ||
    (args[0] === 'migrate' &&
      args[1] === 'diff' &&
      args.includes('--from-empty') &&
      args.includes('--to-schema'))
  if (explicitProduction) requireProductionMode()
  if (
    process.env.NODE_ENV === 'production' &&
    !offline &&
    (args[0] !== 'migrate' ||
      !['status', 'deploy', 'diff'].includes(args[1] ?? ''))
  )
    throw new EnvironmentError(['NODE_ENV'])
  const production = process.env.NODE_ENV === 'production'
  const migration = offline ? undefined : parseMigrationEnvironment()
  const deploying = args[0] === 'migrate' && args[1] === 'deploy'
  if (migration && (deploying || production)) {
    const { createDatabase, checkDatabase } =
      await import('../src/db/client.ts')
    const database = createDatabase(
      migration.DATABASE_URL,
      migration.MYSQL_AUTH_PUBLIC_KEY_FILE,
    )
    try {
      if (deploying) await migrationPreflight(database)
      else await checkDatabase(database)
    } finally {
      await database.$disconnect()
    }
  }
  const result = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), ...args],
    {
      encoding: 'utf8',
      stdio: production && migration ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
    },
  )
  if (result.error) throw result.error
  if (production && migration) {
    const target = new URL(migration.DATABASE_URL)
    const secrets = [
      migration.DATABASE_URL,
      target.password,
      decodeURIComponent(target.password),
    ]
    const redact = (text: string) =>
      secrets.reduce(
        (output, secret) => output.replaceAll(secret, '[redacted]'),
        text,
      )
    process.stdout.write(redact(result.stdout ?? ''))
    process.stderr.write(redact(result.stderr ?? ''))
  }
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(
    error instanceof EnvironmentError ||
      error instanceof SuspendedMigrationError
      ? error.message
      : 'Prisma command failed.',
  )
  process.exitCode = 1
}
