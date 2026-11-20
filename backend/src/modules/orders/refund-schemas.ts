import { z } from 'zod'

// Same bounded offline evidence format as T17; REFUND eligibility is checked
// against locked payment facts, never inferred from this client input.
import {
  listPayments,
  recordPayment,
  confirmPayment,
  failPayment,
} from './payment-schemas.ts'

export const listRefunds = listPayments
export const recordRefund = recordPayment
export const confirmRefund = confirmPayment
export const failRefund = failPayment
export type RefundIntent =
  | {
      operation: 'REFUND_RECORDED'
      id: string
      input: z.output<typeof recordRefund>
    }
  | {
      operation: 'REFUND_CONFIRMED'
      id: string
      input: z.output<typeof confirmRefund>
    }
  | {
      operation: 'REFUND_FAILED'
      id: string
      input: z.output<typeof failRefund>
    }
