import { z } from 'zod'

export const fulfillOrder = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2147483647),
  fulfillmentNote: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || null),
})
export type FulfillmentInput = z.output<typeof fulfillOrder>
