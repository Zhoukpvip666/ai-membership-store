import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { completeProduct } from '../products/schemas.ts'
import { mutation } from '../subscriptions/idempotency.ts'
import { adminOrderDto, adminOrderSelect, customerOrderDto } from './dto.ts'
import { buildOrderSnapshot, orderRevisionSelect } from './revisions.ts'
import { creationForm } from './create-form.ts'
import type { AdminCreation, CustomerCreation } from './create-schemas.ts'

type Intent =
  | { role: 'CUSTOMER'; input: CustomerCreation }
  | { role: 'ADMIN'; input: AdminCreation }

export function orderCreationService(database: PrismaClient) {
  return async (
    intent: Intent,
    actorId: string,
    key: string,
    requestId: string,
  ) =>
    mutation(
      database,
      actorId,
      key,
      intent.role === 'ADMIN' ? 'ADMIN_ORDER_CREATE' : 'CUSTOMER_ORDER_CREATE',
      intent.input,
      async (tx) => {
        const admin = intent.role === 'ADMIN' ? intent.input : null
        const userId = admin?.userId ?? actorId
        // Both paths acquire locks in the same order: target User, then Product.
        // All eligibility checks happen after locking, not on stale HTTP reads.
        await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`
        const customer = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            status: true,
            notificationEmail: true,
            loginEmail: true,
          },
        })
        if (!customer || customer.role !== 'CUSTOMER')
          throw new ApiError(404, 'CUSTOMER_NOT_FOUND', '客户不存在')
        if (admin && customer.status === 'DISABLED')
          throw new ApiError(409, 'CUSTOMER_DISABLED', '客户已停用')
        if (!admin && customer.status !== 'ACTIVE')
          throw new ApiError(403, 'ACCOUNT_NOT_ELIGIBLE', '账户尚不可下单')
        const { productId } = intent.input
        await tx.$queryRaw`SELECT id FROM Product WHERE id = ${productId} FOR UPDATE`
        const product = await tx.product.findUnique({
          where: { id: productId },
        })
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '商品不存在')
        if (
          intent.role === 'CUSTOMER' &&
          product.updatedAt.toISOString() !==
            intent.input.expectedProductUpdatedAt
        )
          throw new ApiError(
            409,
            'PRODUCT_CHANGED',
            '商品信息已变更，请重新确认',
          )
        if (product.archivedAt)
          throw new ApiError(409, 'PRODUCT_ARCHIVED', '商品已归档')
        if (!admin && !product.listed)
          throw new ApiError(409, 'PRODUCT_NOT_AVAILABLE', '商品尚未上架')
        if (
          product.type === 'SUBSCRIPTION' &&
          (!product.servicePeriodUnit || !product.servicePeriodCount)
        )
          throw new ApiError(
            409,
            'PRODUCT_PERIOD_UNCONFIGURED',
            '商品周期尚未配置',
          )
        // Reuse the complete product contract; a legacy NULL period is not orderable.
        completeProduct.parse({
          name: product.name,
          description: product.description,
          type: product.type,
          priceFen: product.priceFen,
          renewalPriceFen: product.renewalPriceFen,
          termLabel: product.termLabel,
          servicePeriodUnit: product.servicePeriodUnit,
          servicePeriodCount: product.servicePeriodCount,
          listed: product.listed,
          sortOrder: product.sortOrder,
          formSchema: product.formSchema,
        })
        const formData = creationForm(product.formSchema, intent.input.formData)
        const amountFen = admin?.amountFen ?? product.priceFen
        if (
          admin &&
          amountFen !== product.priceFen &&
          !admin.priceAdjustmentReason
        )
          throw new ApiError(
            400,
            'PRICE_ADJUSTMENT_REASON_REQUIRED',
            '调整价格时必须填写原因',
          )
        const actorType = admin ? 'ADMIN' : 'USER'
        const order = await tx.order.create({
          data: {
            orderNo: 'O' + randomUUID().replaceAll('-', ''),
            version: 1,
            userId,
            productId,
            source: actorType,
            createdByAdminId: admin ? actorId : null,
            createdByUserId: admin ? null : actorId,
            kind: product.type === 'SUBSCRIPTION' ? 'INITIAL' : 'ONE_TIME',
            hidden: false,
            productNameSnapshot: product.name,
            productDescriptionSnapshot: product.description,
            productTypeSnapshot: product.type,
            priceSnapshotFen: product.priceFen,
            renewalPriceSnapshotFen: product.renewalPriceFen,
            termSnapshot: product.termLabel,
            servicePeriodUnitSnapshot: product.servicePeriodUnit,
            servicePeriodCountSnapshot: product.servicePeriodCount,
            formSchemaSnapshot: product.formSchema as Prisma.InputJsonValue,
            formData,
            amountFen,
            contactEmailSnapshot:
              customer.notificationEmail ?? customer.loginEmail,
            internalNote: admin?.internalNote ?? null,
            paymentStatus: amountFen === 0 ? 'NOT_REQUIRED' : 'UNPAID',
            fulfillmentStatus: amountFen === 0 ? 'PROCESSING' : 'NOT_STARTED',
          },
          select: { ...orderRevisionSelect, user: adminOrderSelect.user },
        })
        await tx.orderRevision.create({
          data: {
            orderId: order.id,
            version: 1,
            snapshotSchemaVersion: 1,
            snapshotJson: buildOrderSnapshot(order),
            actorType,
            actorUserId: actorId,
            reason: admin?.priceAdjustmentReason ?? null,
          },
        })
        // Operational logs contain state/price facts, never submitted form/note contents.
        const state = {
          version: 1,
          amountFen,
          priceSnapshotFen: product.priceFen,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
        }
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: 'ORDER_CREATED',
            actorType,
            actorUserId: admin ? null : actorId,
            actorAdminId: admin ? actorId : null,
            toStateJson: state,
            note: admin?.priceAdjustmentReason ?? null,
          },
        })
        if (admin)
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: actorId,
              action: 'ORDER_CREATED',
              entityType: 'Order',
              entityId: order.id,
              requestId,
              reason: admin.priceAdjustmentReason,
              afterJson: state,
            },
          })
        return { order: admin ? adminOrderDto(order) : customerOrderDto(order) }
      },
    )
}
