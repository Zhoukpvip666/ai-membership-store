import { z } from 'zod'
import { id } from '../users/schemas.ts'
import { ApiError } from '../../http/errors.ts'

const common = {
  productId: id,
  formData: z.record(z.string(), z.unknown()),
}
export const createCustomerOrder = z.strictObject({
  ...common,
  expectedProductUpdatedAt: z.iso.datetime({ precision: 3 }),
})
export const createAdminOrder = z.strictObject({
  ...common,
  userId: id,
  amountFen: z.number().int().min(0).max(2147483647),
  priceAdjustmentReason: z.string().trim().min(1).max(500).optional(),
  internalNote: z.string().trim().max(2000).nullable().default(null),
})
export type CustomerCreation = z.output<typeof createCustomerOrder>
export type AdminCreation = z.output<typeof createAdminOrder>

// Hash the exact validated header. Never trim a key into another key's namespace.
export function creationKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '请提供有效的幂等密钥')
  return value
}
