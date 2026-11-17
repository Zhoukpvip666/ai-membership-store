import { Prisma, type PrismaClient } from '../generated/prisma/client.ts'

export async function transaction<T>(
  database: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await database.$transaction(action, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < 3
      )
        continue
      throw error
    }
  }
}
