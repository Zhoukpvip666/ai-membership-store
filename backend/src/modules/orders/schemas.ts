import { z } from 'zod'

const pageNumber = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(max))
const filters = {
  search: z.string().trim().max(254).default(''),
  orderNo: z.string().trim().max(40).default(''),
  productName: z.string().trim().max(120).default(''),
  kind: z.enum(['INITIAL', 'ONE_TIME', 'RENEWAL']).optional(),
  paymentStatus: z
    .enum([
      'UNPAID',
      'PENDING_VERIFICATION',
      'PAID',
      'REFUND_PENDING',
      'REFUNDED',
      'NOT_REQUIRED',
    ])
    .optional(),
  fulfillmentStatus: z
    .enum(['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'])
    .optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
  page: pageNumber(10000).default(1),
  pageSize: pageNumber(100).default(20),
}

export const listCustomerOrders = z.strictObject(filters)
export const listAdminOrders = z.strictObject({
  ...filters,
  productType: z.enum(['SUBSCRIPTION', 'ONE_TIME']).optional(),
  customer: z.string().trim().max(254).default(''),
})
export const orderDetailQuery = z.strictObject({})
