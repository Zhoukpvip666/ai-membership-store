import { createHash } from 'node:crypto'
import { Prisma } from '../../generated/prisma/client.ts'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export async function mutation<T>(
  db: PrismaClient,
  actorId: string,
  key: string | undefined,
  operation: string,
  input: unknown,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const requestHash = hash(canonical({ operation, input }))
  const keyHash = key ? hash(key) : undefined
  const lookup = async (tx: Prisma.TransactionClient) =>
    keyHash
      ? tx.idempotencyRecord.findUnique({
          where: { actorAdminId_keyHash: { actorAdminId: actorId, keyHash } },
        })
      : null
  const replay = (record: {
    requestHash: string
    responseJson: Prisma.JsonValue
  }) => {
    if (record.requestHash !== requestHash)
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '幂等密钥已用于不同请求')
    return record.responseJson as T
  }
  try {
    return await transaction(db, async (tx) => {
      const previous = await lookup(tx)
      if (previous) return replay(previous)
      const result = JSON.parse(JSON.stringify(await action(tx))) as T
      if (keyHash)
        await tx.idempotencyRecord.create({
          data: {
            actorAdminId: actorId,
            keyHash,
            requestHash,
            operation,
            responseJson: result as Prisma.InputJsonValue,
          },
        })
      return result
    })
  } catch (error) {
    // Concurrent identical requests may collide on the unique key after both read.
    // The losing transaction is rolled back, including its subscription/events/audit.
    if (
      keyHash &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const previous = await lookup(db)
      if (previous) return replay(previous)
    }
    throw error
  }
}
