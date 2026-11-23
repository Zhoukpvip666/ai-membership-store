import {
  parseProductionBootstrapEnvironment,
  EnvironmentError,
} from '../src/config/env.ts'
import { createDatabase } from '../src/db/client.ts'
import { BootstrapMigrationError } from '../src/db/bootstrap-migrations.ts'
import {
  bootstrapProductionAdministrator,
  SeedConflictError,
} from '../src/db/seed.ts'

try {
  const env = parseProductionBootstrapEnvironment()
  const database = createDatabase(
    env.BOOTSTRAP_DATABASE_URL,
    env.MYSQL_AUTH_PUBLIC_KEY_FILE,
  )
  try {
    await bootstrapProductionAdministrator(database, env)
    console.info('Production administrator initialized.')
  } finally {
    await database.$disconnect()
  }
} catch (error) {
  console.error(
    error instanceof EnvironmentError ||
      error instanceof BootstrapMigrationError ||
      error instanceof SeedConflictError
      ? error.message
      : 'Production bootstrap failed. Check the target, migration history and bootstrap grants.',
  )
  process.exitCode = 1
}
