import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { transaction } from '../../db/transaction.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import { paymentDto, paymentSelect } from './payments.ts'
import type { RefundIntent } from './refund-schemas.ts'

type Payment = Prisma.PaymentTransactionGetPayload<{
  select: typeof paymentSelect
}>
const ordinary = {
  hidden: false,
  source: { in: ['USER', 'ADMIN'] as ('USER' | 'ADMIN')[] },
  kind: { in: ['INITIAL', 'ONE_TIME'] as ('INITIAL' | 'ONE_TIME')[] },
}
const orderSelect = {
  ...orderRevisionSelect,
  user: adminOrderSelect.user,
} as const
const notFound = () => new ApiError(404, 'NOT_FOUND', '订单或退款记录不存在')
const ineligible = () =>
  new ApiError(409, 'ORDER_NOT_REFUNDABLE', '订单当前不可处理退款')

export function offlineRefundService(database: PrismaClient) {
  return {
    list: (orderId: string, query: { page: number; pageSize: number }) =>
      transaction(database, async (tx) => {
        if (
          !(await tx.order.findFirst({
            where: { id: orderId, ...ordinary },
            select: { id: true },
          }))
        )
          throw notFound()
        const where = { orderId, kind: 'REFUND' as const }
        const items = await tx.paymentTransaction.findMany({
          where,
          select: paymentSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        })
        const total = await tx.paymentTransaction.count({ where })
        return { items: items.map(paymentDto), total, ...query }
      }),
    write: async (
      intent: RefundIntent,
      actorId: string,
      key: string,
      requestId: string,
    ) => {
      const recording = intent.operation === 'REFUND_RECORDED'
      // Non-locking locator outside the transaction avoids both reversed locks
      // under Serializable and nested acquisition of the finite connection pool.
      const locator = recording
        ? null
        : await database.paymentTransaction.findUnique({
            where: { id: intent.id },
            select: { orderId: true },
          })
      return mutation(
        database,
        actorId,
        key,
        intent.operation,
        { id: intent.id, ...intent.input },
        async (tx) => {
          if (!recording && !locator) throw notFound()
          const orderId = recording ? intent.id : locator!.orderId
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
          const order = await tx.order.findFirst({
            where: { id: orderId, ...ordinary },
            select: orderSelect,
          })
          if (!order) throw notFound()
          await tx.$queryRaw`SELECT id FROM \`PaymentTransaction\` WHERE orderId = ${orderId} ORDER BY id FOR UPDATE`
          const transactions = await tx.paymentTransaction.findMany({
            where: { orderId },
            select: paymentSelect,
          })
          const refunds = transactions.filter((row) => row.kind === 'REFUND')
          const target = recording
            ? undefined
            : refunds.find((row) => row.id === intent.id)
          if (!recording && !target) throw notFound()
          if (order.version !== intent.input.expectedVersion)
            throw new ApiError(
              409,
              'VERSION_CONFLICT',
              '订单版本已变化，请重新读取',
            )
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT UTC_TIMESTAMP(3) AS now`
          const now = clock!.now
          const receipts = transactions.filter(
            (row) =>
              row.kind === 'PAYMENT' &&
              (row.status === 'CONFIRMED' || row.confirmedAt !== null),
          )
          const receipt = receipts[0]
          if (
            order.amountFen <= 0 ||
            order.paymentStatus !== 'REFUND_PENDING' ||
            order.fulfillmentStatus !== 'CANCELLED' ||
            !order.cancelledAt ||
            order.fulfilledAt ||
            !order.paidAt ||
            !order.paymentConfirmedAt ||
            receipts.length !== 1 ||
            receipt?.status !== 'CONFIRMED' ||
            receipt.amountFen !== order.amountFen ||
            receipt.occurredAt.getTime() !== order.paidAt.getTime() ||
            receipt.confirmedAt?.getTime() !==
              order.paymentConfirmedAt.getTime() ||
            order.paidAt > order.paymentConfirmedAt ||
            refunds.some(
              (row) => row.status === 'CONFIRMED' || row.confirmedAt !== null,
            )
          )
            throw ineligible()
          if (
            target &&
            (target.status !== 'PENDING' || target.confirmedAt !== null)
          )
            throw new ApiError(409, 'REFUND_NOT_PENDING', '退款记录已处理')
          const pending = refunds.filter((row) => row.status === 'PENDING')
          if (
            (recording && pending.length !== 0) ||
            (!recording &&
              (pending.length !== 1 || pending[0]!.id !== target!.id))
          )
            throw new ApiError(
              409,
              'OTHER_PENDING_REFUNDS',
              '请先核实已有的待处理退款',
            )
          const amountFen = recording
            ? intent.input.amountFen
            : target!.amountFen
          const channel = recording ? intent.input.channel : target!.channel
          if (amountFen !== receipt.amountFen)
            throw new ApiError(
              409,
              'REFUND_AMOUNT_MISMATCH',
              '仅支持退回原始全额付款',
            )
          if (channel !== receipt.channel)
            throw new ApiError(
              409,
              'REFUND_CHANNEL_MISMATCH',
              '退款渠道必须与原付款一致',
            )
          const occurredAt = recording
            ? new Date(intent.input.occurredAt)
            : target!.occurredAt
          if (occurredAt < receipt.occurredAt || occurredAt > now)
            throw new ApiError(
              recording ? 400 : 409,
              'REFUND_TIME_INVALID',
              '退款发生时间不在有效范围内',
            )
          const confirming = intent.operation === 'REFUND_CONFIRMED'
          let saved: Payment
          if (intent.operation === 'REFUND_RECORDED')
            saved = await tx.paymentTransaction.create({
              data: {
                orderId,
                kind: 'REFUND',
                status: 'PENDING',
                amountFen,
                channel,
                occurredAt,
                externalReference: intent.input.externalReference,
                note: intent.input.note,
                createdByAdminId: actorId,
              },
              select: paymentSelect,
            })
          else
            saved = await tx.paymentTransaction.update({
              where: { id: target!.id },
              data: confirming
                ? {
                    status: 'CONFIRMED',
                    confirmedAt: now,
                    confirmedByAdminId: actorId,
                  }
                : { status: 'FAILED' },
              select: paymentSelect,
            })
          // No createdAt/deadline predicate: refund handling is independent of the
          // initial 24-hour payment window. Never touch original receipt/cancel facts.
          const count = await tx.$executeRaw`
          UPDATE \`Order\` SET paymentStatus = ${confirming ? 'REFUNDED' : 'REFUND_PENDING'},
            version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${orderId} AND version = ${intent.input.expectedVersion}
            AND hidden = FALSE AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
            AND amountFen > 0 AND paymentStatus = 'REFUND_PENDING' AND fulfillmentStatus = 'CANCELLED'
            AND paidAt IS NOT NULL AND paymentConfirmedAt IS NOT NULL AND cancelledAt IS NOT NULL AND fulfilledAt IS NULL
        `
          if (count !== 1) throw ineligible()
          const updated = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            select: orderSelect,
          })
          const reason =
            intent.operation === 'REFUND_FAILED' ? intent.input.reason : null
          await tx.orderRevision.create({
            data: {
              orderId,
              version: updated.version,
              snapshotSchemaVersion: 1,
              snapshotJson: buildOrderSnapshot(updated),
              actorType: 'ADMIN',
              actorUserId: actorId,
              reason,
            },
          })
          const state = (row: typeof order, refund?: Payment) => ({
            operation: intent.operation,
            orderId,
            transactionId: refund?.id ?? null,
            version: row.version,
            paymentStatus: row.paymentStatus,
            fulfillmentStatus: row.fulfillmentStatus,
            amountFen: refund?.amountFen ?? null,
            channel: refund?.channel ?? null,
            transactionStatus: refund?.status ?? null,
            ...(reason === null ? {} : { reason }),
          })
          const beforeJson = state(order, target),
            afterJson = state(updated, saved)
          await tx.orderEvent.create({
            data: {
              orderId,
              eventType:
                intent.operation === 'REFUND_FAILED'
                  ? 'NOTE'
                  : intent.operation,
              actorType: 'ADMIN',
              actorAdminId: actorId,
              fromStateJson: beforeJson,
              toStateJson: afterJson,
              note: reason,
            },
          })
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: actorId,
              action: intent.operation,
              entityType: 'PaymentTransaction',
              entityId: saved.id,
              requestId,
              beforeJson,
              afterJson,
              reason,
            },
          })
          return {
            order: adminOrderDto(updated, now),
            paymentTransaction: paymentDto(saved),
          }
        },
      )
    },
  }
}
