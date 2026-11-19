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
const missing = () => new ApiError(404, 'NOT_FOUND', '订单不存在')
const customerSearch = (search: string): Prisma.UserWhereInput => ({
  OR: [
    { loginEmail: { contains: search } },
    { username: { contains: search } },
    { adminLabel: { contains: search } },
  ],
})

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
    orderNo: { contains: input.orderNo },
    productNameSnapshot: { contains: input.productName },
    OR: [
      { orderNo: { contains: input.search } },
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
      return {
        items: rows.map(adminOrderDto),
        total,
        page: input.page,
        pageSize: input.pageSize,
      }
    },
    async detailAdmin(orderId: string) {
      const order = await database.order.findFirst({
        where: { id: orderId, hidden: false },
        select: adminOrderSelect,
      })
      if (!order) throw missing()
      return adminOrderDto(order)
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
      return {
        items: rows.map(customerOrderDto),
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
