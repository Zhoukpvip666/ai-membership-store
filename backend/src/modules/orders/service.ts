import type { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import type { listAdminOrders, listCustomerOrders } from './schemas.ts'
import {
  adminOrderDto,
  adminOrderSelect,
  customerOrderDto,
  customerOrderSelect,
} from './dto.ts'

type CustomerFilters = z.output<typeof listCustomerOrders>
type AdminFilters = z.output<typeof listAdminOrders>
const linkedSubscriptionSelect = {
  id: true,
  sourceType: true,
  status: true,
  version: true,
  productNameSnapshot: true,
  startedAt: true,
  expiresAt: true,
} as const satisfies Prisma.SubscriptionSelect
const missing = () => new ApiError(404, 'NOT_FOUND', '订单不存在')
const customerSearch = (search: string): Prisma.UserWhereInput => ({
  OR: [
    { loginEmail: { contains: search } },
    { username: { contains: search } },
    { adminLabel: { contains: search } },
  ],
})

function orderNumberSearch(search: string): Prisma.OrderWhereInput[] {
  const filters: Prisma.OrderWhereInput[] = [{ orderNo: { contains: search } }]
  if (/^[0-9]{3} [0-9]{3} [0-9]{3}$/.test(search))
    filters.push({ orderNo: search.replaceAll(' ', '') })
  return filters
}

function orderWhere(
  input: CustomerFilters,
  userId?: string,
): Prisma.OrderWhereInput {
  return {
    hidden: false,
    userId,
    kind: input.kind,
    paymentStatus: input.paymentStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    AND: [{ OR: orderNumberSearch(input.orderNo) }],
    productNameSnapshot: { contains: input.productName },
    OR: [
      ...orderNumberSearch(input.search),
      { productNameSnapshot: { contains: input.search } },
      // Private customer labels are searchable only in the ADMIN scope.
      ...(userId === undefined
        ? [{ user: { is: customerSearch(input.search) } }]
        : []),
    ],
  }
}

export function orderReadService(database: PrismaClient) {
  return {
    async listAdmin(input: AdminFilters) {
      const where: Prisma.OrderWhereInput = {
        ...orderWhere(input),
        productTypeSnapshot: input.productType,
        ...(input.customer
          ? { user: { is: customerSearch(input.customer) } }
          : {}),
      }
      const [rows, total] = await database.$transaction([
        database.order.findMany({
          where,
          select: adminOrderSelect,
          orderBy: [{ createdAt: input.sort }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        database.order.count({ where }),
      ])
      const now = new Date()
      return {
        items: rows.map((row) => adminOrderDto(row, now)),
        total,
        page: input.page,
        pageSize: input.pageSize,
      }
    },
    async detailAdmin(orderId: string) {
      const order = await database.order.findFirst({
        where: { id: orderId, hidden: false },
        select: {
          ...adminOrderSelect,
          sourcedSubscription: { select: linkedSubscriptionSelect },
          subscription: { select: linkedSubscriptionSelect },
        },
      })
      if (!order) throw missing()
      return {
        ...adminOrderDto(order),
        linkedSubscription:
          order.kind === 'INITIAL' && order.fulfillmentStatus === 'COMPLETED'
            ? order.sourcedSubscription
            : order.kind === 'RENEWAL'
              ? order.subscription
              : null,
      }
    },
    async listCustomer(userId: string, input: CustomerFilters) {
      const where = orderWhere(input, userId)
      const [rows, total] = await database.$transaction([
        database.order.findMany({
          where,
          select: customerOrderSelect,
          orderBy: [{ createdAt: input.sort }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        database.order.count({ where }),
      ])
      const now = new Date()
      return {
        items: rows.map((row) => customerOrderDto(row, now)),
        total,
        page: input.page,
        pageSize: input.pageSize,
      }
    },
    async detailCustomer(userId: string, orderId: string) {
      const order = await database.order.findFirst({
        where: { id: orderId, hidden: false, userId },
        select: customerOrderSelect,
      })
      if (!order) throw missing()
      return customerOrderDto(order)
    },
  }
}
