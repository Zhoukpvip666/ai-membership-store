import { z } from 'zod'

const expectedVersion = z.number().int().min(1).max(2147483647)
export const cancelCustomerOrder = z.strictObject({
  expectedVersion,
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
})
export const cancelAdminOrder = z.strictObject({
  expectedVersion,
  reason: z.string().trim().min(1).max(500),
})
export type CancellationInput = z.output<typeof cancelCustomerOrder>
