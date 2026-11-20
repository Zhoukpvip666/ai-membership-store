import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { transaction } from '../../db/transaction.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import type { PaymentIntent } from './payment-schemas.ts'

// Evidence is ADMIN-only. Neither relations nor arbitrary Prisma fields are DTOs.
export const paymentSelect = {
  id: true,
  orderId: true,
  kind: true,
  channel: true,
  amountFen: true,
  status: true,
  externalReference: true,
  occurredAt: true,
  confirmedAt: true,
  createdByAdminId: true,
  confirmedByAdminId: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PaymentTransactionSelect
type Payment = Prisma.PaymentTransactionGetPayload<{
  select: typeof paymentSelect
}>
function paymentDto(row: Payment) {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    channel: row.channel,
    amountFen: row.amountFen,
    status: row.status,
    externalReference: row.externalReference,
    occurredAt: row.occurredAt,
    confirmedAt: row.confirmedAt,
    createdByAdminId: row.createdByAdminId,
    confirmedByAdminId: row.confirmedByAdminId,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
const ordinary = {
  hidden: false,
  source: { in: ['USER', 'ADMIN'] as ('USER' | 'ADMIN')[] },
  kind: { in: ['INITIAL', 'ONE_TIME'] as ('INITIAL' | 'ONE_TIME')[] },
}
const orderSelect = {
  ...orderRevisionSelect,
  user: adminOrderSelect.user,
} as const
const notFound = () => new ApiError(404, 'NOT_FOUND', '订单或付款记录不存在')
const ineligible = () =>
  new ApiError(409, 'ORDER_NOT_PAYABLE', '订单当前不可处理付款')

export function offlinePaymentService(database: PrismaClient) {
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
        const where = { orderId, kind: 'PAYMENT' as const }
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
      intent: PaymentIntent,
      actorId: string,
      key: string,
      requestId: string,
    ) => {
      const recording = intent.operation === 'PAYMENT_RECORDED'
      // Locate before acquiring a transaction connection: concurrent writers
      // must not exhaust the pool while waiting for a second connection here.
      // This read authorizes nothing; replay still precedes all state checks.
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
          // A Serializable locator inside tx could implicitly lock the attempt
          // before Order. Revalidate the earlier non-locking locator below.
          if (!recording && !locator) throw notFound()
          const orderId = recording ? intent.id : locator!.orderId
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
          const order = await tx.order.findFirst({
            where: { id: orderId, ...ordinary },
            select: orderSelect,
          })
          if (!order) throw notFound()
          // Deterministic parent-first locks serialize all attempts and T16 writers.
          // Re-read membership under these locks; never trust the earlier locator.
          await tx.$queryRaw`SELECT id FROM \`PaymentTransaction\` WHERE orderId = ${orderId} AND kind = 'PAYMENT' ORDER BY id FOR UPDATE`
          const payments = await tx.paymentTransaction.findMany({
            where: { orderId, kind: 'PAYMENT' },
            select: paymentSelect,
          })
          const target = recording
            ? undefined
            : payments.find((row) => row.id === intent.id)
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
          const now = clock!.now,
            deadline = order.createdAt.getTime() + 86400000
          if (
            order.amountFen <= 0 ||
            !['UNPAID', 'PENDING_VERIFICATION'].includes(order.paymentStatus) ||
            order.fulfillmentStatus !== 'NOT_STARTED' ||
            order.cancelledAt ||
            order.fulfilledAt ||
            order.paidAt ||
            order.paymentConfirmedAt ||
            now.getTime() >= deadline ||
            payments.some(
              (row) => row.status === 'CONFIRMED' || row.confirmedAt !== null,
            )
          )
            throw ineligible()
          if (
            target &&
            (target.status !== 'PENDING' || target.confirmedAt !== null)
          )
            throw new ApiError(409, 'PAYMENT_NOT_PENDING', '付款记录已处理')
          const confirming = intent.operation === 'PAYMENT_CONFIRMED'
          const occurredAt = recording
            ? new Date(intent.input.occurredAt)
            : target!.occurredAt
          if (
            (recording || confirming) &&
            (occurredAt < order.createdAt ||
              occurredAt > now ||
              occurredAt.getTime() >= deadline)
          )
            throw new ApiError(
              recording ? 400 : 409,
              'PAYMENT_TIME_INVALID',
              '付款发生时间不在订单有效范围内',
            )
          if (confirming && target!.amountFen !== order.amountFen)
            throw new ApiError(
              409,
              'PAYMENT_AMOUNT_MISMATCH',
              '仅可确认与应付金额一致的完整付款',
            )
          if (
            confirming &&
            payments.some(
              (row) => row.id !== target!.id && row.status === 'PENDING',
            )
          )
            throw new ApiError(
              409,
              'OTHER_PENDING_PAYMENTS',
              '请先逐笔核实其他待处理付款',
            )
          let saved: Payment
          if (intent.operation === 'PAYMENT_RECORDED')
            saved = await tx.paymentTransaction.create({
              data: {
                orderId,
                kind: 'PAYMENT',
                status: 'PENDING',
                amountFen: intent.input.amountFen,
                channel: intent.input.channel,
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
              select: paymentSelect,
              data: confirming
                ? {
                    status: 'CONFIRMED',
                    confirmedAt: now,
                    confirmedByAdminId: actorId,
                  }
                : { status: 'FAILED' },
            })
          const paymentStatus =
            recording ||
            (!confirming &&
              payments.some(
                (row) => row.id !== target!.id && row.status === 'PENDING',
              ))
              ? 'PENDING_VERIFICATION'
              : confirming
                ? 'PAID'
                : 'UNPAID'
          const count = await tx.$executeRaw`
          UPDATE \`Order\` SET paymentStatus = ${paymentStatus},
            fulfillmentStatus = ${confirming ? 'PROCESSING' : 'NOT_STARTED'},
            paidAt = ${confirming ? occurredAt : null}, paymentConfirmedAt = ${confirming ? now : null},
            version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${orderId} AND version = ${intent.input.expectedVersion}
            AND hidden = FALSE AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
            AND amountFen > 0 AND paymentStatus IN ('UNPAID','PENDING_VERIFICATION')
            AND fulfillmentStatus = 'NOT_STARTED' AND paidAt IS NULL AND paymentConfirmedAt IS NULL
            AND cancelledAt IS NULL AND fulfilledAt IS NULL
            AND createdAt > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
        `
          if (count !== 1) throw ineligible()
          const updated = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            select: orderSelect,
          })
          const reason =
            intent.operation === 'PAYMENT_FAILED' ? intent.input.reason : null
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
          const state = (row: typeof order, payment?: Payment) => ({
            operation: intent.operation,
            orderId,
            transactionId: saved.id,
            version: row.version,
            paymentStatus: row.paymentStatus,
            fulfillmentStatus: row.fulfillmentStatus,
            amountFen: payment?.amountFen ?? saved.amountFen,
            channel: payment?.channel ?? saved.channel,
            transactionStatus: payment?.status ?? null,
          })
          const beforeJson = state(order, target),
            afterJson = state(updated, saved)
          await tx.orderEvent.create({
            data: {
              orderId,
              eventType:
                intent.operation === 'PAYMENT_FAILED'
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
