import { Prisma, type PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import { wechatPaymentService } from '../settings/wechat-payment.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { customerOrderDto } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'

const payable = Prisma.sql`
  source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
  AND amountFen > 0 AND paymentStatus = 'UNPAID' AND fulfillmentStatus = 'NOT_STARTED'
  AND paidAt IS NULL AND paymentConfirmedAt IS NULL AND fulfilledAt IS NULL AND cancelledAt IS NULL
  AND createdAt > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
  AND NOT EXISTS (
    SELECT 1 FROM PaymentTransaction AS receipt WHERE receipt.orderId = \`Order\`.id
      AND receipt.kind = 'PAYMENT' AND (receipt.status <> 'FAILED' OR receipt.confirmedAt IS NOT NULL)
  )
`
const missing = () => new ApiError(404, 'NOT_FOUND', '订单不存在')

export function customerWechatPayment(
  db: PrismaClient,
  storageDirectory?: string,
) {
  const wechat = wechatPaymentService(db, storageDirectory)
  return {
    image(orderId: string, userId: string) {
      return transaction(db, async (tx) => {
        const [owned] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM \`Order\` WHERE id = ${orderId} AND userId = ${userId}
            AND hidden = FALSE FOR SHARE
        `
        if (!owned) throw missing()
        const [order] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM \`Order\` WHERE id = ${orderId} AND ${payable}
        `
        if (!order) throw missing()
        return wechat.readEnabledImage(tx)
      })
    },
    claim(
      orderId: string,
      userId: string,
      expectedVersion: number,
      key: string,
    ) {
      return mutation(
        db,
        userId,
        key,
        'CUSTOMER_PAYMENT_CLAIMED',
        { orderId, expectedVersion },
        async (tx) => {
          const [order] = await tx.$queryRaw<{ version: number }[]>`
            SELECT version FROM \`Order\` WHERE id = ${orderId}
              AND userId = ${userId} AND hidden = FALSE FOR UPDATE
          `
          if (!order) throw missing()
          if (order.version !== expectedVersion)
            throw new ApiError(
              409,
              'VERSION_CONFLICT',
              '订单版本已变化，请重新读取',
            )
          const changed = await tx.$executeRaw`
            UPDATE \`Order\` SET paymentStatus = 'PENDING_VERIFICATION',
              version = version + 1, updatedAt = UTC_TIMESTAMP(3)
            WHERE id = ${orderId} AND userId = ${userId} AND hidden = FALSE
              AND version = ${expectedVersion} AND ${payable}
          `
          if (changed !== 1)
            throw new ApiError(
              409,
              'ORDER_NOT_PAYABLE',
              '订单当前不可提交付款核实',
            )
          const saved = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            select: orderRevisionSelect,
          })
          await tx.orderRevision.create({
            data: {
              orderId,
              version: saved.version,
              snapshotSchemaVersion: 1,
              snapshotJson: buildOrderSnapshot(saved),
              actorType: 'USER',
              actorUserId: userId,
            },
          })
          const state = (version: number, paymentStatus: string) => ({
            operation: 'CUSTOMER_PAYMENT_CLAIMED',
            version,
            paymentStatus,
            fulfillmentStatus: saved.fulfillmentStatus,
          })
          await tx.orderEvent.create({
            data: {
              orderId,
              eventType: 'NOTE',
              actorType: 'USER',
              actorUserId: userId,
              fromStateJson: state(order.version, 'UNPAID'),
              toStateJson: state(saved.version, saved.paymentStatus),
            },
          })
          return { order: customerOrderDto(saved) }
        },
      )
    },
  }
}
