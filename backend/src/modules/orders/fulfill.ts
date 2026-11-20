import {
  Prisma,
  type PrismaClient,
  type Subscription,
} from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import { paymentSelect } from './payments.ts'
import { creationForm } from './create-form.ts'
import { canonicalBillingTimezone, periodEnd } from './service-period.ts'
import type { FulfillmentInput } from './fulfill-schemas.ts'

const select = {
  ...orderRevisionSelect,
  user: adminOrderSelect.user,
  product: { select: { id: true } },
} as const
const ordinary = {
  hidden: false,
  source: { in: ['USER', 'ADMIN'] as ('USER' | 'ADMIN')[] },
  kind: { in: ['INITIAL', 'ONE_TIME'] as ('INITIAL' | 'ONE_TIME')[] },
}
const ineligible = () =>
  new ApiError(
    409,
    'ORDER_NOT_FULFILLABLE',
    '订单当前不可履约或付款/商品快照不完整',
  )
const integerFen = (value: number | null): value is number =>
  value !== null && Number.isInteger(value) && value >= 0 && value <= 2147483647

// A separate explicit ADMIN response; no relations, credentials or audit internals.
export function fulfilledSubscriptionDto(s: Subscription) {
  return {
    id: s.id,
    userId: s.userId,
    productId: s.productId,
    sourceType: s.sourceType,
    sourceOrderId: s.sourceOrderId,
    productNameSnapshot: s.productNameSnapshot,
    productDescriptionSnapshot: s.productDescriptionSnapshot,
    productTypeSnapshot: s.productTypeSnapshot,
    priceSnapshotFen: s.priceSnapshotFen,
    termSnapshot: s.termSnapshot,
    servicePeriodUnitSnapshot: s.servicePeriodUnitSnapshot,
    servicePeriodCountSnapshot: s.servicePeriodCountSnapshot,
    formSchemaSnapshot: s.formSchemaSnapshot,
    formData: s.formData,
    renewalPriceFen: s.renewalPriceFen,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    billingAnchorAt: s.billingAnchorAt,
    billingTimezone: s.billingTimezone,
    billingRevision: s.billingRevision,
    currentPeriodStartAt: s.currentPeriodStartAt,
    currentPeriodEndAt: s.currentPeriodEndAt,
    earlyRenewalUsed: s.earlyRenewalUsed,
    earlyRenewedPeriodStartAt: s.earlyRenewedPeriodStartAt,
    earlyRenewalOrderId: s.earlyRenewalOrderId,
    status: s.status,
    version: s.version,
    createdByAdminId: s.createdByAdminId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

export function orderFulfillmentService(database: PrismaClient) {
  return (
    orderId: string,
    input: FulfillmentInput,
    actorId: string,
    key: string,
    requestId: string,
  ) =>
    mutation(
      database,
      actorId,
      key,
      'ORDER_FULFILLED',
      { id: orderId, ...input },
      async (tx) => {
        // Shared T16/T17/T18 protocol: parent first, then all attempts, then settings.
        await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM PaymentTransaction WHERE orderId = ${orderId} ORDER BY id FOR UPDATE`
        const order = await tx.order.findFirst({
          where: { id: orderId, ...ordinary },
          select,
        })
        if (!order) throw new ApiError(404, 'NOT_FOUND', '订单不存在')
        const payments = await tx.paymentTransaction.findMany({
          where: { orderId },
          select: paymentSelect,
        })
        if (order.version !== input.expectedVersion)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            '订单版本已变化，请重新读取',
          )
        if (
          order.fulfillmentStatus !== 'PROCESSING' ||
          order.fulfilledAt ||
          order.cancelledAt ||
          order.cancellationReason !== null ||
          !order.user ||
          !order.product
        )
          throw ineligible()
        const receipts = payments.filter(
          (p) =>
            p.kind === 'PAYMENT' &&
            (p.status === 'CONFIRMED' || p.confirmedAt !== null),
        )
        const receipt = receipts[0]
        if (order.paymentStatus === 'PAID') {
          if (
            order.amountFen <= 0 ||
            !order.paidAt ||
            !order.paymentConfirmedAt ||
            receipts.length !== 1 ||
            receipt?.status !== 'CONFIRMED' ||
            receipt.amountFen !== order.amountFen ||
            receipt.occurredAt.getTime() !== order.paidAt.getTime() ||
            receipt.confirmedAt?.getTime() !==
              order.paymentConfirmedAt.getTime() ||
            order.paidAt > order.paymentConfirmedAt ||
            payments.some((p) => p.kind === 'REFUND' || p.status === 'PENDING')
          )
            throw ineligible()
        } else if (
          order.paymentStatus !== 'NOT_REQUIRED' ||
          order.amountFen !== 0 ||
          order.paidAt ||
          order.paymentConfirmedAt ||
          payments.length !== 0
        )
          throw ineligible()

        if (!integerFen(order.priceSnapshotFen)) throw ineligible()
        const initial = order.kind === 'INITIAL'
        if (
          initial
            ? order.productTypeSnapshot !== 'SUBSCRIPTION' ||
              !order.servicePeriodUnitSnapshot ||
              !Number.isInteger(order.servicePeriodCountSnapshot) ||
              (order.servicePeriodCountSnapshot ?? 0) <= 0 ||
              !integerFen(order.renewalPriceSnapshotFen)
            : order.productTypeSnapshot !== 'ONE_TIME'
        )
          throw ineligible()
        try {
          creationForm(order.formSchemaSnapshot, order.formData)
        } catch {
          throw ineligible()
        }
        let timezone: string | undefined
        if (initial) {
          // Read-lock settings for the entire transaction: updates must wait,
          // while independent fulfillments can freeze the same configuration.
          await tx.$queryRaw`SELECT id FROM AppSettings WHERE id = 1 FOR SHARE`
          const settings = await tx.appSettings.findUnique({
            where: { id: 1 },
            select: { timezone: true },
          })
          try {
            timezone = canonicalBillingTimezone(settings?.timezone ?? '')
          } catch {
            throw new ApiError(
              503,
              'SETTINGS_UNAVAILABLE',
              '计费时区未配置或不受支持',
            )
          }
        }
        if (
          await tx.subscription.findUnique({
            where: { sourceOrderId: orderId },
            select: { id: true },
          })
        )
          throw ineligible()
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT UTC_TIMESTAMP(3) AS now`
        const now = clock!.now
        if (order.paymentConfirmedAt && order.paymentConfirmedAt > now)
          throw ineligible()
        let subscription: Subscription | undefined
        if (initial) {
          let expiresAt: Date
          try {
            const end = periodEnd(
              now.toISOString(),
              timezone!,
              order.servicePeriodUnitSnapshot!,
              order.servicePeriodCountSnapshot!,
            )
            expiresAt = new Date(end.epochMilliseconds)
            if (expiresAt.getUTCFullYear() > 9999)
              throw new RangeError('MySQL date range exceeded')
          } catch {
            throw ineligible()
          }
          subscription = await tx.subscription.create({
            data: {
              userId: order.userId,
              productId: order.productId,
              sourceOrderId: order.id,
              sourceType: 'ORDER',
              productNameSnapshot: order.productNameSnapshot,
              productDescriptionSnapshot: order.productDescriptionSnapshot,
              productTypeSnapshot: 'SUBSCRIPTION',
              priceSnapshotFen: order.priceSnapshotFen!,
              termSnapshot: order.termSnapshot,
              servicePeriodUnitSnapshot: order.servicePeriodUnitSnapshot,
              servicePeriodCountSnapshot: order.servicePeriodCountSnapshot,
              formSchemaSnapshot: structuredClone(
                order.formSchemaSnapshot,
              ) as Prisma.InputJsonValue,
              formData: structuredClone(
                order.formData,
              ) as Prisma.InputJsonValue,
              renewalPriceFen: order.renewalPriceSnapshotFen!,
              startedAt: now,
              expiresAt,
              billingAnchorAt: now,
              billingTimezone: timezone!,
              billingRevision: 1,
              currentPeriodStartAt: now,
              currentPeriodEndAt: expiresAt,
              earlyRenewalUsed: false,
              earlyRenewedPeriodStartAt: null,
              earlyRenewalOrderId: null,
              status: 'ACTIVE',
              version: 1,
              createdByAdminId: actorId,
              createdAt: now,
              updatedAt: now,
            },
          })
        }
        const changed =
          await tx.$executeRaw`UPDATE \`Order\` SET fulfillmentStatus = 'COMPLETED', fulfilledAt = ${now},
        version = version + 1, updatedAt = ${now}
        WHERE id = ${orderId} AND version = ${input.expectedVersion} AND hidden = FALSE
        AND source IN ('USER','ADMIN') AND kind IN ('INITIAL','ONE_TIME') AND fulfillmentStatus = 'PROCESSING'
        AND fulfilledAt IS NULL AND cancelledAt IS NULL AND cancellationReason IS NULL
        AND ((paymentStatus = 'PAID' AND amountFen > 0 AND paidAt IS NOT NULL AND paymentConfirmedAt IS NOT NULL)
          OR (paymentStatus = 'NOT_REQUIRED' AND amountFen = 0 AND paidAt IS NULL AND paymentConfirmedAt IS NULL))`
        if (changed !== 1) throw ineligible()
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
            reason: input.fulfillmentNote,
            createdAt: now,
          },
        })
        const state = (o: typeof order, subscriptionId: string | null) => ({
          operation: 'ORDER_FULFILLED',
          orderId,
          version: o.version,
          paymentStatus: o.paymentStatus,
          fulfillmentStatus: o.fulfillmentStatus,
          fulfilledAt: o.fulfilledAt?.toISOString() ?? null,
          subscriptionId,
        })
        const beforeJson = state(order, null),
          afterJson = state(updated, subscription?.id ?? null)
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: 'COMPLETED',
            actorType: 'ADMIN',
            actorAdminId: actorId,
            fromStateJson: beforeJson,
            toStateJson: afterJson,
            note: input.fulfillmentNote,
            createdAt: now,
          },
        })
        const entitlementState = subscription
          ? {
              id: subscription.id,
              orderId,
              sourceType: 'ORDER',
              status: subscription.status,
              version: subscription.version,
              startedAt: now.toISOString(),
              expiresAt: subscription.expiresAt.toISOString(),
              billingAnchorAt: now.toISOString(),
              billingTimezone: timezone!,
              billingRevision: 1,
              currentPeriodStartAt: now.toISOString(),
              currentPeriodEndAt: subscription.expiresAt.toISOString(),
              earlyRenewalUsed: false,
            }
          : undefined
        if (subscription)
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: subscription.id,
              orderId,
              eventType: 'CREATED',
              actorType: 'ADMIN',
              actorAdminId: actorId,
              newStartedAt: now,
              newExpiresAt: subscription.expiresAt,
              beforeJson: Prisma.DbNull,
              afterJson: entitlementState!,
              reason: input.fulfillmentNote,
              createdAt: now,
            },
          })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'ORDER_FULFILLED',
            entityType: 'Order',
            entityId: orderId,
            requestId,
            beforeJson,
            afterJson,
            reason: input.fulfillmentNote,
            createdAt: now,
          },
        })
        if (subscription)
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: actorId,
              action: 'SUBSCRIPTION_CREATED',
              entityType: 'Subscription',
              entityId: subscription.id,
              requestId,
              beforeJson: Prisma.DbNull,
              afterJson: entitlementState!,
              reason: input.fulfillmentNote,
              createdAt: now,
            },
          })
        return {
          order: adminOrderDto(updated, now),
          ...(subscription
            ? { subscription: fulfilledSubscriptionDto(subscription) }
            : {}),
        }
      },
    )
}
