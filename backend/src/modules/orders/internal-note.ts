import type { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import type { updateInternalNote } from './center-schemas.ts'

export function orderNoteService(db: PrismaClient) {
  return (
    orderId: string,
    input: z.output<typeof updateInternalNote>,
    actorId: string,
    key: string,
    requestId: string,
  ) =>
    mutation(
      db,
      actorId,
      key,
      'ORDER_INTERNAL_NOTE_UPDATED',
      { orderId, ...input },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
        const select = { ...orderRevisionSelect, user: adminOrderSelect.user }
        const order = await tx.order.findFirst({
          where: {
            id: orderId,
            hidden: false,
            source: { in: ['USER', 'ADMIN'] },
          },
          select,
        })
        if (!order) throw new ApiError(404, 'NOT_FOUND', '订单不存在')
        if (order.version !== input.expectedVersion)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            '订单版本已变化，请重新读取并核对',
          )
        if (order.internalNote === input.internalNote)
          throw new ApiError(400, 'NO_CHANGES', '内部备注没有变化')
        const changed =
          await tx.$executeRaw`UPDATE \`Order\` SET internalNote = ${input.internalNote}, version = version + 1, updatedAt = UTC_TIMESTAMP(3) WHERE id = ${orderId} AND version = ${input.expectedVersion} AND hidden = FALSE AND source IN ('USER', 'ADMIN')`
        if (changed !== 1)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            '订单版本已变化，请重新读取并核对',
          )
        const updated = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select,
        })
        await tx.orderRevision.create({
          data: {
            orderId,
            version: updated.version,
            snapshotSchemaVersion: 1,
            snapshotJson: buildOrderSnapshot(updated),
            actorType: 'ADMIN',
            actorUserId: actorId,
            reason: null,
          },
        })
        const state = (row: typeof order) => ({
          operation: 'ORDER_INTERNAL_NOTE_UPDATED',
          version: row.version,
          internalNote: row.internalNote,
        })
        const beforeJson = state(order),
          afterJson = state(updated)
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: 'NOTE',
            actorType: 'ADMIN',
            actorAdminId: actorId,
            fromStateJson: beforeJson,
            toStateJson: afterJson,
            note: null,
          },
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'ORDER_INTERNAL_NOTE_UPDATED',
            entityType: 'Order',
            entityId: orderId,
            requestId,
            beforeJson,
            afterJson,
            reason: null,
          },
        })
        return { order: adminOrderDto(updated) }
      },
    )
}
