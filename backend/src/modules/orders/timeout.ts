import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { startExpiryScheduler } from '../subscriptions/scheduler.ts'
import { cancelLockedOrder, cancellationSelect } from './cancel.ts'

export type TimeoutResult = {
  scanned: number
  cancelled: number
  failed: number
}
export function orderTimeoutService(database: PrismaClient) {
  return async (): Promise<TimeoutResult> => {
    const candidates = await database.$queryRaw<{ id: string }[]>`
      SELECT id FROM \`Order\`
      WHERE hidden = FALSE AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
        AND paymentStatus IN ('UNPAID','PENDING_VERIFICATION') AND fulfillmentStatus = 'NOT_STARTED'
        AND cancelledAt IS NULL AND paidAt IS NULL AND paymentConfirmedAt IS NULL AND fulfilledAt IS NULL
        AND createdAt <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
      ORDER BY createdAt ASC, id ASC LIMIT 100
    `
    const result = { scanned: candidates.length, cancelled: 0, failed: 0 }
    for (const { id } of candidates) {
      try {
        const cancelled = await transaction(database, async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM \`Order\` WHERE id = ${id}
              AND hidden = FALSE AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
              AND paymentStatus IN ('UNPAID','PENDING_VERIFICATION') AND fulfillmentStatus = 'NOT_STARTED'
              AND cancelledAt IS NULL AND paidAt IS NULL AND paymentConfirmedAt IS NULL AND fulfilledAt IS NULL
              AND createdAt <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
            FOR UPDATE SKIP LOCKED
          `
          if (locked.length === 0) return false
          const order = await tx.order.findUniqueOrThrow({
            where: { id },
            select: cancellationSelect,
          })
          await cancelLockedOrder(tx, order, {
            type: 'SYSTEM',
            id: null,
            reason: 'PAYMENT_TIMEOUT',
          })
          return true
        })
        if (cancelled) result.cancelled++
      } catch {
        // No private record values/driver errors in logs. One row cannot poison
        // the rest of the batch; a later minute retries its entire transaction.
        result.failed++
      }
    }
    return result
  }
}

export function startOrderTimeoutScheduler(
  sweep: () => Promise<TimeoutResult>,
  onError: () => void,
) {
  return startExpiryScheduler(async () => {
    if ((await sweep()).failed > 0) onError()
    // One bounded pass per minute; never spin on an oldest failing row.
    return 0
  }, onError)
}
