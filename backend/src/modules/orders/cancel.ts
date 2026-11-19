import { Prisma, type PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect, customerOrderDto } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import type { CancellationInput } from './cancel-schemas.ts'

export const cancellationSelect = {
  ...orderRevisionSelect,
  user: adminOrderSelect.user,
} as const
type CancellationOrder = Prisma.OrderGetPayload<{
  select: typeof cancellationSelect
}>
type Actor = {
  type: 'USER' | 'ADMIN' | 'SYSTEM'
  id: string | null
  reason: string | null
  requestId?: string
}
const ineligible = () =>
  new ApiError(409, 'ORDER_NOT_CANCELLABLE', '订单当前不可取消')

// Call only while holding this Order's exclusive row lock in the same transaction.
export async function cancelLockedOrder(
  tx: Prisma.TransactionClient,
  order: CancellationOrder,
  actor: Actor,
) {
  if (
    order.hidden ||
    !['USER', 'ADMIN'].includes(order.source ?? '') ||
    !['INITIAL', 'ONE_TIME'].includes(order.kind) ||
    order.cancelledAt ||
    order.fulfilledAt
  )
    throw ineligible()
  const payments = await tx.paymentTransaction.findMany({
    where: { orderId: order.id, kind: 'PAYMENT' },
    select: {
      status: true,
      amountFen: true,
      occurredAt: true,
      confirmedAt: true,
    },
  })
  const confirmed = payments.filter(
    (p) => p.status === 'CONFIRMED' || p.confirmedAt !== null,
  )
  const noPaidFacts =
    !order.paidAt && !order.paymentConfirmedAt && confirmed.length === 0
  const unpaid =
    order.fulfillmentStatus === 'NOT_STARTED' &&
    noPaidFacts &&
    (order.paymentStatus === 'UNPAID' ||
      (actor.type !== 'ADMIN' &&
        order.paymentStatus === 'PENDING_VERIFICATION'))
  const zero =
    actor.type === 'ADMIN' &&
    order.paymentStatus === 'NOT_REQUIRED' &&
    order.fulfillmentStatus === 'PROCESSING' &&
    order.amountFen === 0 &&
    noPaidFacts &&
    payments.length === 0
  const receipt = confirmed[0]
  const paid =
    actor.type === 'ADMIN' &&
    order.paymentStatus === 'PAID' &&
    order.fulfillmentStatus === 'PROCESSING' &&
    order.amountFen > 0 &&
    order.paidAt &&
    order.paymentConfirmedAt &&
    confirmed.length === 1 &&
    receipt?.status === 'CONFIRMED' &&
    receipt.amountFen === order.amountFen &&
    receipt.occurredAt.getTime() === order.paidAt.getTime() &&
    receipt.confirmedAt?.getTime() === order.paymentConfirmedAt.getTime() &&
    order.paidAt.getTime() <= order.paymentConfirmedAt.getTime()
  if (!unpaid && !zero && !paid) throw ineligible()

  const changed = await tx.$executeRaw`
    UPDATE \`Order\` SET fulfillmentStatus = 'CANCELLED',
      paymentStatus = ${paid ? 'REFUND_PENDING' : zero ? 'NOT_REQUIRED' : 'UNPAID'},
      cancelledAt = UTC_TIMESTAMP(3), cancellationReason = ${actor.reason},
      version = version + 1, updatedAt = UTC_TIMESTAMP(3)
    WHERE id = ${order.id} AND version = ${order.version} AND hidden = FALSE
      AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
      AND paymentStatus = ${order.paymentStatus} AND fulfillmentStatus = ${order.fulfillmentStatus}
      AND cancelledAt IS NULL AND fulfilledAt IS NULL
      AND (${actor.type !== 'SYSTEM'} OR
        (paidAt IS NULL AND paymentConfirmedAt IS NULL AND createdAt <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)))
  `
  if (changed !== 1) throw ineligible()
  await tx.paymentTransaction.updateMany({
    where: {
      orderId: order.id,
      kind: 'PAYMENT',
      status: 'PENDING',
      confirmedAt: null,
    },
    data: {
      status: 'FAILED',
      note: actor.type === 'SYSTEM' ? 'PAYMENT_TIMEOUT' : 'ORDER_CANCELLED',
    },
  })
  const updated = await tx.order.findUniqueOrThrow({
    where: { id: order.id },
    select: cancellationSelect,
  })
  await tx.orderRevision.create({
    data: {
      orderId: order.id,
      version: updated.version,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(updated),
      actorType: actor.type,
      actorUserId: actor.id,
      reason: actor.reason,
    },
  })
  const state = (row: CancellationOrder) => ({
    operation: 'ORDER_CANCELLED',
    version: row.version,
    amountFen: row.amountFen,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  })
  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      eventType: 'CANCELLED',
      actorType: actor.type,
      actorAdminId: actor.type === 'ADMIN' ? actor.id : null,
      actorUserId: actor.type === 'USER' ? actor.id : null,
      fromStateJson: state(order),
      toStateJson: state(updated),
      note: actor.reason,
    },
  })
  if (actor.type === 'ADMIN')
    await tx.adminAuditLog.create({
      data: {
        actorAdminId: actor.id,
        action: 'ORDER_CANCELLED',
        entityType: 'Order',
        entityId: order.id,
        requestId: actor.requestId,
        reason: actor.reason,
        beforeJson: state(order),
        afterJson: state(updated),
      },
    })
  return updated
}

export function orderCancellationService(database: PrismaClient) {
  return async (
    role: 'CUSTOMER' | 'ADMIN',
    input: CancellationInput,
    orderId: string,
    actorId: string,
    key: string,
    requestId: string,
  ) =>
    mutation(
      database,
      actorId,
      key,
      role === 'ADMIN' ? 'ADMIN_ORDER_CANCEL' : 'CUSTOMER_ORDER_CANCEL',
      { orderId, ...input },
      async (tx) => {
        if (role === 'CUSTOMER')
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} AND userId = ${actorId} FOR UPDATE`
        else
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
        const order = await tx.order.findFirst({
          where: {
            id: orderId,
            ...(role === 'CUSTOMER' ? { userId: actorId } : {}),
          },
          select: cancellationSelect,
        })
        if (!order) throw new ApiError(404, 'NOT_FOUND', '订单不存在')
        if (order.version !== input.expectedVersion)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            '订单版本已变化，请重新读取',
          )
        const updated = await cancelLockedOrder(tx, order, {
          type: role === 'ADMIN' ? 'ADMIN' : 'USER',
          id: actorId,
          reason: input.reason,
          requestId,
        })
        return {
          order:
            role === 'ADMIN'
              ? adminOrderDto(updated)
              : customerOrderDto(updated),
        }
      },
    )
}
