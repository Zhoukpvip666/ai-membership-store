import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'

// Internal history only. Never spread a Prisma row or expose this as customer DTO.
// paymentRecordedAt is retained as legacy metadata; it never substitutes paidAt.
export const orderRevisionSelect = {
  id: true,
  orderNo: true,
  userId: true,
  productId: true,
  productNameSnapshot: true,
  termSnapshot: true,
  contactEmailSnapshot: true,
  subscriptionId: true,
  productDescriptionSnapshot: true,
  targetIdentifier: true,
  cancellationReason: true,
  internalNote: true,
  createdByAdminId: true,
  createdByUserId: true,
  billingTimezoneSnapshot: true,
  amountFen: true,
  version: true,
  priceSnapshotFen: true,
  servicePeriodCountSnapshot: true,
  renewalPriceSnapshotFen: true,
  billingRevisionSnapshot: true,
  createdAt: true,
  updatedAt: true,
  paidAt: true,
  paymentRecordedAt: true,
  paymentConfirmedAt: true,
  fulfilledAt: true,
  cancelledAt: true,
  renewalPeriodStartAt: true,
  renewalPeriodEndAt: true,
  renewalForPeriodStartAt: true,
  billingAnchorSnapshotAt: true,
  kind: true,
  source: true,
  productTypeSnapshot: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  servicePeriodUnitSnapshot: true,
  hidden: true,
  formSchemaSnapshot: true,
  formData: true,
} as const satisfies Prisma.OrderSelect

export const orderSnapshotV1 = z.strictObject({
  snapshotSchemaVersion: z.literal(1),
  order: z.strictObject({
    id: z.string(),
    orderNo: z.string(),
    userId: z.string(),
    productId: z.string(),
    productNameSnapshot: z.string(),
    termSnapshot: z.string(),
    contactEmailSnapshot: z.string(),
    subscriptionId: z.string().nullable(),
    productDescriptionSnapshot: z.string().nullable(),
    targetIdentifier: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    internalNote: z.string().nullable(),
    createdByAdminId: z.string().nullable(),
    createdByUserId: z.string().nullable(),
    billingTimezoneSnapshot: z.string().nullable(),
    amountFen: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    priceSnapshotFen: z.number().int().nullable(),
    servicePeriodCountSnapshot: z.number().int().nullable(),
    renewalPriceSnapshotFen: z.number().int().nullable(),
    billingRevisionSnapshot: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    paidAt: z.iso.datetime().nullable(),
    paymentRecordedAt: z.iso.datetime().nullable(),
    paymentConfirmedAt: z.iso.datetime().nullable(),
    fulfilledAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    renewalPeriodStartAt: z.iso.datetime().nullable(),
    renewalPeriodEndAt: z.iso.datetime().nullable(),
    renewalForPeriodStartAt: z.iso.datetime().nullable(),
    billingAnchorSnapshotAt: z.iso.datetime().nullable(),
    kind: z.enum(['INITIAL', 'RENEWAL', 'ONE_TIME']),
    source: z.enum(['USER', 'ADMIN', 'SYSTEM_RENEWAL']),
    productTypeSnapshot: z.enum(['SUBSCRIPTION', 'ONE_TIME']),
    paymentStatus: z.enum([
      'UNPAID',
      'PENDING_VERIFICATION',
      'PAID',
      'REFUND_PENDING',
      'REFUNDED',
      'NOT_REQUIRED',
    ]),
    fulfillmentStatus: z.enum([
      'NOT_STARTED',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ]),
    servicePeriodUnitSnapshot: z.enum(['DAY', 'MONTH', 'YEAR']).nullable(),
    hidden: z.boolean(),
    formSchemaSnapshot: z.json(),
    formData: z.json(),
  }),
})

type RevisionOrder = Prisma.OrderGetPayload<{
  select: typeof orderRevisionSelect
}>
export function buildOrderSnapshot(order: RevisionOrder) {
  const whitelisted = Object.fromEntries(
    Object.keys(orderRevisionSelect).map((key) => [
      key,
      order[key as keyof RevisionOrder],
    ]),
  )
  // Copy JSON values and normalize UTC timestamps, then reject missing/extra fields.
  return orderSnapshotV1.parse(
    JSON.parse(
      JSON.stringify({ snapshotSchemaVersion: 1, order: whitelisted }),
    ),
  )
}
