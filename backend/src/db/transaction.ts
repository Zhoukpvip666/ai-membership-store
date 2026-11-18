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
      const known = error instanceof Prisma.PrismaClientKnownRequestError
      const adapter = known
        ? (error.meta?.driverAdapterError as
            | {
                cause?: { originalCode?: string; kind?: string }
              }
            | undefined)
        : undefined
      // Prisma 7 driver adapters nest raw SQL deadlocks in driverAdapterError.
      const rawConflict =
        known &&
        error.code === 'P2010' &&
        (adapter?.cause?.kind === 'TransactionWriteConflict' ||
          ['1213', '1205'].includes(
            String(error.meta?.code ?? adapter?.cause?.originalCode),
          ))
      if (known && (error.code === 'P2034' || rawConflict) && attempt < 3)
        continue
      throw error
    }
  }
}
