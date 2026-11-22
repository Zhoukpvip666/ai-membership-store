import { z } from 'zod'

export const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
export const password = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (value) => value.trim().length >= 12 && !value.startsWith('replace_with_'),
  )
export const id = z.uuid()
const profile = {
  adminLabel: z.string().trim().min(1).max(80).nullable().optional(),
  notificationEmail: email.nullable().optional(),
}
export const createCustomer = z.strictObject({ ...profile, loginEmail: email })
export const editCustomer = z
  .strictObject({
    adminLabel: profile.adminLabel.optional(),
    notificationEmail: profile.notificationEmail,
  })
  .refine((value) => Object.keys(value).length > 0)
export const changeStatus = z.strictObject({
  disabled: z.boolean(),
  reason: z.string().trim().min(1).max(500),
})
export const listCustomers = z.strictObject({
  search: z.string().trim().max(254).default(''),
  status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'DISABLED']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export const emptyBody = z.strictObject({})
export const login = z.strictObject({ email, password })
export const register = z.strictObject({ email, password })
export const activation = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password,
})
