import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { transaction } from '../../db/transaction.ts'

const actorSelect = {
  adminLabel: true,
  username: true,
  loginEmail: true,
} as const
const select = {
  id: true,
  eventType: true,
  actorType: true,
  createdAt: true,
  note: true,
  fromStateJson: true,
  toStateJson: true,
  actorAdmin: { select: actorSelect },
  actorUser: { select: actorSelect },
} as const satisfies Prisma.OrderEventSelect
type Event = Prisma.OrderEventGetPayload<{ select: typeof select }>
const operations = {
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_EDITED: 'NOTE',
  ORDER_CANCELLED: 'CANCELLED',
  PAYMENT_RECORDED: 'PAYMENT_RECORDED',
  CUSTOMER_PAYMENT_CLAIMED: 'NOTE',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED: 'NOTE',
  REFUND_RECORDED: 'REFUND_RECORDED',
  REFUND_CONFIRMED: 'REFUND_CONFIRMED',
  REFUND_FAILED: 'NOTE',
  ORDER_FULFILLED: 'COMPLETED',
  ORDER_INTERNAL_NOTE_UPDATED: 'NOTE',
} as const
const paymentStatus = z.enum([
  'UNPAID',
  'PENDING_VERIFICATION',
  'PAID',
  'REFUND_PENDING',
  'REFUNDED',
  'NOT_REQUIRED',
])
const fulfillmentStatus = z.enum([
  'NOT_STARTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])
const integer = z.number().int().min(0).max(2147483647)
const identifier = z.uuid().nullable()
const record = (v: Prisma.JsonValue) =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : {}

// Never spread persisted JSON. A recognized operation AND matching event type
// selects the only fields that can be projected; each scalar is validated alone.
export function orderEventDto(row: Event) {
  const before = record(row.fromStateJson),
    after = record(row.toStateJson)
  const marker =
    after.operation ??
    before.operation ??
    (Object.hasOwn(operations, row.eventType) ? row.eventType : null)
  const operation =
    typeof marker === 'string' &&
    Object.hasOwn(operations, marker) &&
    operations[marker as keyof typeof operations] === row.eventType &&
    (before.operation === undefined || before.operation === marker)
      ? (marker as keyof typeof operations)
      : null
  const summary: Record<string, string | number | null> = {}
  if (operation) {
    const fields: Record<string, z.ZodType> = { version: integer.min(1) }
    if (operation === 'ORDER_INTERNAL_NOTE_UPDATED')
      fields.internalNote = z.string().max(2000).nullable()
    else {
      fields.paymentStatus = paymentStatus
      fields.fulfillmentStatus = fulfillmentStatus
      if (
        ['ORDER_CREATED', 'ORDER_EDITED', 'ORDER_CANCELLED'].includes(operation)
      )
        fields.amountFen = integer
      if (operation === 'ORDER_CANCELLED')
        fields.cancelledAt = z.iso.datetime().nullable()
      if (operation === 'ORDER_FULFILLED') {
        fields.fulfilledAt = z.iso.datetime().nullable()
        fields.subscriptionId = identifier
      }
      if (operation.startsWith('PAYMENT_') || operation.startsWith('REFUND_')) {
        fields.transactionId = identifier
        fields.amountFen = integer.nullable()
        fields.channel = z
          .enum(['WECHAT', 'ALIPAY', 'BANK_TRANSFER', 'CASH', 'OTHER'])
          .nullable()
        fields.transactionStatus = z
          .enum(['PENDING', 'CONFIRMED', 'FAILED'])
          .nullable()
        summary.transactionKind = operation.startsWith('PAYMENT_')
          ? 'PAYMENT'
          : 'REFUND'
      }
    }
    for (const [field, validator] of Object.entries(fields))
      for (const [suffix, state] of [
        ['Before', before],
        ['After', after],
      ] as const) {
        const result = validator.safeParse(state[field])
        if (result.success)
          summary[field + suffix] = result.data as string | number | null
      }
  }
  const actor = row.actorType === 'ADMIN' ? row.actorAdmin : row.actorUser
  const actorDisplayName =
    row.actorType === 'SYSTEM'
      ? '系统'
      : (row.actorType === 'ADMIN' ? actor?.adminLabel?.trim() : null) ||
        actor?.username?.trim() ||
        actor?.loginEmail.split('@')[0] ||
        '未知操作人'
  return {
    id: row.id,
    eventType: row.eventType,
    operation,
    actorType: row.actorType,
    actorDisplayName,
    createdAt: row.createdAt,
    note: row.note,
    summary,
  }
}
export function orderEventService(db: PrismaClient) {
  return (orderId: string, query: { page: number; pageSize: number }) =>
    transaction(db, async (tx) => {
      if (
        !(await tx.order.findFirst({
          where: { id: orderId, hidden: false },
          select: { id: true },
        }))
      )
        throw new ApiError(404, 'NOT_FOUND', '订单不存在')
      const where = { orderId }
      const items = await tx.orderEvent.findMany({
        where,
        select,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      })
      const total = await tx.orderEvent.count({ where })
      return { items: items.map(orderEventDto), total, ...query }
    })
}
