import assert from 'node:assert/strict'
import { createDatabase } from '../../src/db/client.ts'
import { hashPassword } from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

// Only the isolated runner invokes this fixture. No Seed entrypoint, development
// credentials, customers, orders or subscriptions are used by this setup.
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
try {
  assert.equal(await db.user.count(), 0)
  assert.equal(await db.appSettings.count(), 0)
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD)
  await db.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        loginEmail: env.ADMIN_EMAIL,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    })
    // Also used before applying the current AppSettings migration.
    await tx.$executeRaw`INSERT INTO AppSettings (id,storeName,ownerEmail,updatedAt)
      VALUES (1,'Isolated product fixture',${env.ADMIN_EMAIL},UTC_TIMESTAMP(3))`
  })
} finally {
  await db.$disconnect()
}
