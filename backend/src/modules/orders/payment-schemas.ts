import { z } from 'zod'

const expectedVersion = z.number().int().positive().max(2147483647)
const pageNumber = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(max))
export const listPayments = z.strictObject({
  page: pageNumber(10000).default(1),
  pageSize: pageNumber(100).default(20),
})
export const recordPayment = z.strictObject({
  expectedVersion,
  amountFen: z.number().int().positive().max(2147483647),
  channel: z.enum(['WECHAT', 'ALIPAY', 'BANK_TRANSFER', 'CASH', 'OTHER']),
  occurredAt: z.iso.datetime({ precision: 3 }),
  externalReference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
})
export const confirmPayment = z.strictObject({ expectedVersion })
export const claimPayment = z.strictObject({ expectedVersion })
export const failPayment = z.strictObject({
  expectedVersion,
  reason: z.string().trim().min(1).max(500),
})
export type PaymentIntent =
  | {
      operation: 'PAYMENT_RECORDED'
      id: string
      input: z.output<typeof recordPayment>
    }
  | {
      operation: 'PAYMENT_CONFIRMED'
      id: string
      input: z.output<typeof confirmPayment>
    }
  | {
      operation: 'PAYMENT_FAILED'
      id: string
      input: z.output<typeof failPayment>
    }
