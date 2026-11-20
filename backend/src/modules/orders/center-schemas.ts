import { z } from 'zod'
import { listPayments } from './payment-schemas.ts'

export const listOrderEvents = listPayments
export const updateInternalNote = z.strictObject({
  expectedVersion: z.number().int().positive().max(2147483647),
  internalNote: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .transform((v) => v || null),
})
