import { isDeepStrictEqual } from 'node:util'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { creationForm } from './create-form.ts'
import { adminOrderDto, adminOrderSelect, customerOrderDto } from './dto.ts'
import type { AdminEdit, CustomerEdit } from './edit-schemas.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import { orderActorType, orderOperation, type OrderIntent } from './actor.ts'

const ineligible = () =>
  new ApiError(409, 'ORDER_NOT_EDITABLE', '订单当前不可编辑')

export function orderEditService(database: PrismaClient) {
  return async (
    intent: OrderIntent<CustomerEdit, AdminEdit>,
    orderId: string,
    actorId: string,
    key: string,
    requestId: string,
  ) =>
    mutation(
      database,
      actorId,
      key,
      orderOperation(intent, 'EDIT'),
      { orderId, ...intent.input },
      async (tx) => {
        const admin = intent.scope === 'management' ? intent.input : null
        // Include ownership in both the locking query and the ORM read. A foreign
        // ID has the same response as a missing ID, before any state is inspected.
        if (admin)
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
        else
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} AND userId = ${actorId} AND hidden = FALSE FOR UPDATE`
        const order = await tx.order.findFirst({
          where: {
            id: orderId,
            ...(admin ? {} : { userId: actorId, hidden: false }),
          },
          select: { ...orderRevisionSelect, user: adminOrderSelect.user },
        })
        if (!order) throw new ApiError(404, 'NOT_FOUND', '订单不存在')
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT UTC_TIMESTAMP(3) AS now`
        if (
          order.hidden ||
          !['USER', 'ADMIN'].includes(order.source ?? '') ||
          !['INITIAL', 'ONE_TIME'].includes(order.kind) ||
          order.paymentStatus !== 'UNPAID' ||
          order.fulfillmentStatus !== 'NOT_STARTED' ||
          order.cancelledAt ||
          order.paidAt ||
          order.paymentConfirmedAt ||
          order.fulfilledAt ||
          order.createdAt.getTime() + 86400000 <= clock!.now.getTime()
        )
          throw ineligible()
        if (order.version !== intent.input.expectedVersion)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            '订单版本已变化，请重新读取',
          )
        const formData = creationForm(
          order.formSchemaSnapshot,
          intent.input.formData,
        )
        const amountFen = admin?.amountFen ?? order.amountFen
        const priceChanged = amountFen !== order.amountFen
        if (priceChanged && !admin?.priceAdjustmentReason)
          throw new ApiError(
            400,
            'PRICE_ADJUSTMENT_REASON_REQUIRED',
            '调整价格时必须填写原因',
          )
        if (!priceChanged && admin?.priceAdjustmentReason)
          throw new ApiError(
            400,
            'INVALID_INPUT',
            '金额未变化时不应提供调价原因',
          )
        const formChanged = !isDeepStrictEqual(formData, order.formData)
        if (!formChanged && !priceChanged)
          throw new ApiError(400, 'INVALID_INPUT', '订单内容未变化')
        const zero = priceChanged && amountFen === 0
        if (
          await tx.paymentTransaction.findFirst({
            where: {
              orderId,
              ...(zero
                ? {}
                : {
                    OR: [
                      { status: 'CONFIRMED' as const },
                      { confirmedAt: { not: null } },
                    ],
                  }),
            },
            select: { id: true },
          })
        )
          throw ineligible()
        // The database clock is checked again in the actual optimistic UPDATE,
        // so validation or lock waits cannot extend the original 24-hour window.
        const count = await tx.$executeRaw`
          UPDATE \`Order\` SET formData = ${JSON.stringify(formData)}, amountFen = ${amountFen},
            paymentStatus = ${zero ? 'NOT_REQUIRED' : order.paymentStatus},
            fulfillmentStatus = ${zero ? 'PROCESSING' : order.fulfillmentStatus},
            version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${orderId} AND userId = ${order.userId} AND version = ${intent.input.expectedVersion}
            AND hidden = FALSE AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME')
            AND paymentStatus = 'UNPAID' AND fulfillmentStatus = 'NOT_STARTED'
            AND paidAt IS NULL AND paymentConfirmedAt IS NULL AND fulfilledAt IS NULL AND cancelledAt IS NULL
            AND createdAt > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
        `
        if (count !== 1) throw ineligible()
        const updated = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { ...orderRevisionSelect, user: adminOrderSelect.user },
        })
        const actorType = orderActorType(intent)
        const isAdminActor = actorType === 'ADMIN'
        await tx.orderRevision.create({
          data: {
            orderId,
            version: updated.version,
            snapshotSchemaVersion: 1,
            snapshotJson: buildOrderSnapshot(updated),
            actorType,
            actorUserId: actorId,
            reason: admin?.priceAdjustmentReason ?? null,
          },
        })
        const state = (row: typeof order) => ({
          operation: 'ORDER_EDITED',
          version: row.version,
          amountFen: row.amountFen,
          paymentStatus: row.paymentStatus,
          fulfillmentStatus: row.fulfillmentStatus,
        })
        // Full form history lives only in protected revisions, not operational logs.
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: 'NOTE',
            actorType,
            actorUserId: isAdminActor ? null : actorId,
            actorAdminId: isAdminActor ? actorId : null,
            fromStateJson: state(order),
            toStateJson: state(updated),
            note: admin?.priceAdjustmentReason ?? null,
          },
        })
        if (isAdminActor)
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: actorId,
              action: 'ORDER_EDITED',
              entityType: 'Order',
              entityId: orderId,
              requestId,
              reason: admin?.priceAdjustmentReason,
              beforeJson: state(order),
              afterJson: state(updated),
            },
          })
        return {
          order: admin ? adminOrderDto(updated) : customerOrderDto(updated),
        }
      },
    )
}
