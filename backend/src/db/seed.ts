import { Prisma, type PrismaClient } from '../generated/prisma/client.ts'
import { hashPassword } from '../modules/auth/security.ts'
import {
  releaseMigrations,
  verifyBootstrapTarget,
} from './bootstrap-migrations.ts'

// Separate invocations still contend on the same primary key.
const ownerId = '00000000-0000-4000-8000-000000000001'

type AdminCredentials = { ADMIN_EMAIL: string; ADMIN_PASSWORD: string }

export class SeedConflictError extends Error {
  constructor(
    message = 'Administrator bootstrap conflict. Existing accounts and settings were preserved.',
  ) {
    super(message)
    this.name = 'SeedConflictError'
  }
}

export function seedAdministrator(
  database: PrismaClient,
  env: AdminCredentials,
) {
  return initialize(database, env)
}

export function bootstrapProductionAdministrator(
  database: PrismaClient,
  env: AdminCredentials & { PRODUCTION_DATABASE_NAME: string },
) {
  return initialize(database, env, {
    name: env.PRODUCTION_DATABASE_NAME,
    migrations: releaseMigrations(),
  })
}

async function initialize(
  database: PrismaClient,
  env: AdminCredentials,
  target?: { name: string; migrations: ReturnType<typeof releaseMigrations> },
) {
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await database.$transaction(
        async (tx) => {
          if (target) {
            await verifyBootstrapTarget(tx, target.name, target.migrations)
            if (await tx.user.findFirst({ select: { id: true } }))
              throw new SeedConflictError(
                'Production bootstrap requires an empty User table. Existing accounts were preserved.',
              )
          }

          const admins = target
            ? []
            : await tx.user.findMany({ where: { role: 'ADMIN' } })
          let admin = admins[0]
          if (
            admins.length > 1 ||
            (admin &&
              (admin.loginEmail !== env.ADMIN_EMAIL || !admin.passwordHash))
          )
            throw new SeedConflictError()

          const created = !admin
          if (!admin) {
            if (
              !target &&
              (await tx.user.findFirst({
                where: {
                  OR: [{ loginEmail: env.ADMIN_EMAIL }, { id: ownerId }],
                },
                select: { id: true },
              }))
            )
              throw new SeedConflictError()
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
          }

          const settings = {
            id: 1,
            storeName: 'AI 会员商店',
            ownerEmail: env.ADMIN_EMAIL,
          }
          if (target) await tx.appSettings.create({ data: settings })
          else
            await tx.appSettings.upsert({
              where: { id: 1 },
              update: {},
              create: settings,
            })

          if (created)
            await tx.adminAuditLog.create({
              data: {
                actorAdminId: admin.id,
                action: 'ADMIN_BOOTSTRAPPED',
                entityType: 'User',
                entityId: admin.id,
                afterJson: { role: 'ADMIN', status: 'ACTIVE' },
              },
            })
          return { created }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        if (attempt < 3) continue
        throw new SeedConflictError()
      }
      throw error
    }
  }
  throw new SeedConflictError()
}
