import { z } from 'zod'
import { id } from '../users/schemas.ts'

export const fen = z.number().int().min(0).max(2147483647)
export const timestamp = z.iso
  .datetime({ precision: 3 })
  .transform((v) => new Date(v))
const data = z.record(z.string(), z.unknown())
const editable = {
  startedAt: timestamp,
  expiresAt: timestamp,
  renewalPriceFen: fen,
  formData: data,
  note: z.string().max(2000).nullable(),
}
export const createSubscription = z
  .strictObject({
    userId: id,
    productId: id,
    ...editable,
    formData: data.default({}),
    note: editable.note.optional(),
  })
  .refine((v) => v.startedAt < v.expiresAt)
const version = z.number().int().min(1).max(2147483646)
const reason = z.string().trim().min(1).max(500)
export const editSubscription = z
  .strictObject({
    startedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    renewalPriceFen: fen.optional(),
    formData: data.optional(),
    note: editable.note.optional(),
    version,
    reason,
  })
  .refine((v) => Object.keys(v).some((k) => !['version', 'reason'].includes(k)))
export const renewSubscription = z.strictObject({
  version,
  reason,
  newExpiresAt: timestamp,
  renewalPriceFen: fen.optional(),
})
export const terminateSubscription = z.strictObject({ version, reason })
export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .optional()
export const listSubscriptions = z
  .strictObject({
    search: z.string().trim().max(254).default(''),
    userId: id.optional(),
    productId: id.optional(),
    status: z.enum(['ACTIVE', 'TERMINATED']).optional(),
    sourceType: z.enum(['ADMIN', 'SYSTEM']).optional(),
    expiry: z.enum(['ALL', 'UPCOMING', 'EXPIRED']).default('ALL'),
    from: timestamp.optional(),
    to: timestamp.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to)
export const listEvents = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
