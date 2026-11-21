import crypto from 'node:crypto'
import { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'

const maxAttempts = 5

function isOrderNumberCollision(error: unknown) {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  )
    return false
  // The MySQL adapter reports the violated index in structured error metadata.
  const adapter = error.meta?.driverAdapterError as
    { cause?: { kind?: string; constraint?: { index?: string } } } | undefined
  return (
    adapter?.cause?.kind === 'UniqueConstraintViolation' &&
    adapter.cause.constraint?.index === 'Order_orderNo_key'
  )
}

export async function insertWithOrderNumber<T>(
  insert: (orderNo: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const orderNo = String(crypto.randomInt(100_000_000, 1_000_000_000))
    try {
      return await insert(orderNo)
    } catch (error) {
      if (!isOrderNumberCollision(error)) throw error
    }
  }
  throw new ApiError(
    503,
    'ORDER_NUMBER_UNAVAILABLE',
    '暂时无法分配订单号，请重试',
  )
}
