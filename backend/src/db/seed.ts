import { hash, argon2id } from 'argon2'
import { Prisma, type PrismaClient } from '../generated/prisma/client.ts'
import type { Environment } from '../config/env.ts'

// A stable UUID makes simultaneous first seeds contend on the same primary key,
// even when separate shells accidentally use different ADMIN_EMAIL values.
const ownerId = '00000000-0000-4000-8000-000000000001'

export class SeedConflictError extends Error {
  constructor() {
    super(
      'Administrator bootstrap conflict. Existing accounts were preserved; inspect the local database and ADMIN_EMAIL.',
    )
    this.name = 'SeedConflictError'
  }
}

export async function seedAdministrator(
  database: PrismaClient,
  env: Environment,
) {
  // Never log this value, its hash, or the entire Prisma error object.
  const passwordHash = await hash(env.ADMIN_PASSWORD, {
    type: argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await database.$transaction(
        async (tx) => {
          const admins = await tx.user.findMany({ where: { role: 'ADMIN' } })
          if (
            admins.length > 1 ||
            (admins[0] &&
              (admins[0].loginEmail !== env.ADMIN_EMAIL ||
                !admins[0].passwordHash))
          )
            throw new SeedConflictError()

          let created = false
          let admin = admins[0]
          if (!admin) {
            const collision = await tx.user.findFirst({
              where: { OR: [{ loginEmail: env.ADMIN_EMAIL }, { id: ownerId }] },
            })
            if (collision) throw new SeedConflictError()
            admin = await tx.user.create({
              data: {
                id: ownerId,
                adminLabel: 'Owner',
                loginEmail: env.ADMIN_EMAIL,
                notificationEmail: env.ADMIN_EMAIL,
                passwordHash,
                role: 'ADMIN',
                status: 'ACTIVE',
                activatedAt: new Date(),
              },
            })
            created = true
            await tx.adminAuditLog.create({
              data: {
                actorAdminId: admin.id,
                action: 'ADMIN_BOOTSTRAPPED',
                entityType: 'User',
                entityId: admin.id,
                afterJson: { role: 'ADMIN', status: 'ACTIVE' },
              },
            })
          }
          await tx.appSettings.upsert({
            where: { id: 1 },
            update: {},
            create: {
              id: 1,
              storeName: 'AI 会员商店',
              ownerEmail: env.ADMIN_EMAIL,
            },
          })
          return { created }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code) &&
        attempt < 3
      )
        continue
      throw error
    }
  }
  throw new SeedConflictError()
}
