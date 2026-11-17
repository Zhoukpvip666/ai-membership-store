import { parseEnvironment, EnvironmentError } from '../src/config/env.ts'
import { createDatabase } from '../src/db/client.ts'
import { seedAdministrator, SeedConflictError } from '../src/db/seed.ts'

try {
  const env = parseEnvironment()
  const database = createDatabase(env.DATABASE_URL)
  try {
    const { created } = await seedAdministrator(database, env)
    console.info(
      created
        ? 'Administrator initialized.'
        : 'Administrator preserved; no password or profile changes.',
    )
  } finally {
    await database.$disconnect()
  }
} catch (error) {
  console.error(
    error instanceof EnvironmentError || error instanceof SeedConflictError
      ? error.message
      : 'Database seed failed. Check local MySQL and migration status; no credentials were logged.',
  )
  process.exitCode = 1
}
