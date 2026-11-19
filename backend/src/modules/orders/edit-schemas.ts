import { z } from 'zod'

const common = {
  expectedVersion: z.number().int().min(1).max(2147483647),
  formData: z.record(z.string(), z.unknown()),
}
export const editCustomerOrder = z.strictObject(common)
export const editAdminOrder = z.strictObject({
  ...common,
  amountFen: z.number().int().min(0).max(2147483647).optional(),
  priceAdjustmentReason: z.string().trim().min(1).max(500).optional(),
})
export type CustomerEdit = z.output<typeof editCustomerOrder>
export type AdminEdit = z.output<typeof editAdminOrder>
