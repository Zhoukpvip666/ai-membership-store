import type { Prisma } from '../../generated/prisma/client.ts'

// Explicit projections: never join today's Product or fetch internal order data.
export const customerOrderSelect = {
  id: true,
  orderNo: true,
  productId: true,
  kind: true,
  productNameSnapshot: true,
  productDescriptionSnapshot: true,
  productTypeSnapshot: true,
  priceSnapshotFen: true,
  termSnapshot: true,
  servicePeriodUnitSnapshot: true,
  servicePeriodCountSnapshot: true,
  formSchemaSnapshot: true,
  formData: true,
  amountFen: true,
  renewalPriceSnapshotFen: true,
  contactEmailSnapshot: true,
  targetIdentifier: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  createdAt: true,
  paidAt: true,
  paymentConfirmedAt: true,
  fulfilledAt: true,
  cancelledAt: true,
} as const satisfies Prisma.OrderSelect

export const adminOrderSelect = {
  ...customerOrderSelect,
  source: true,
  createdByAdminId: true,
  createdByUserId: true,
  cancellationReason: true,
  user: {
    select: {
      id: true,
      username: true,
      loginEmail: true,
      notificationEmail: true,
    },
  },
} as const satisfies Prisma.OrderSelect

type CustomerOrder = Prisma.OrderGetPayload<{
  select: typeof customerOrderSelect
}>
type AdminOrder = Prisma.OrderGetPayload<{ select: typeof adminOrderSelect }>

export function customerOrderDto(order: CustomerOrder) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    productId: order.productId,
    kind: order.kind,
    productNameSnapshot: order.productNameSnapshot,
    productDescriptionSnapshot: order.productDescriptionSnapshot,
    productTypeSnapshot: order.productTypeSnapshot,
    priceSnapshotFen: order.priceSnapshotFen,
    termSnapshot: order.termSnapshot,
    servicePeriodUnitSnapshot: order.servicePeriodUnitSnapshot,
    servicePeriodCountSnapshot: order.servicePeriodCountSnapshot,
    formSchemaSnapshot: order.formSchemaSnapshot,
    formData: order.formData,
    amountFen: order.amountFen,
    renewalPriceSnapshotFen: order.renewalPriceSnapshotFen,
    contactEmailSnapshot: order.contactEmailSnapshot,
    targetIdentifier: order.targetIdentifier,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
    fulfilledAt: order.fulfilledAt,
    cancelledAt: order.cancelledAt,
  }
}

export function adminOrderDto(order: AdminOrder) {
  return {
    ...customerOrderDto(order),
    customer: {
      id: order.user.id,
      username: order.user.username,
      loginEmail: order.user.loginEmail,
      notificationEmail: order.user.notificationEmail,
    },
    creator: {
      source: order.source,
      adminId: order.createdByAdminId,
      userId: order.createdByUserId,
    },
    cancellationReason: order.cancellationReason,
  }
}
