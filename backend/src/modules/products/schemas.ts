import { z } from 'zod'
import {
  productFormSchema,
  emptyFormSchema,
} from '../../contracts/product-form.ts'
const price = z.number().int().min(0).max(2147483647)
const fields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable(),
  type: z.enum(['SUBSCRIPTION', 'ONE_TIME']),
  priceFen: price,
  renewalPriceFen: price.nullable(),
  termLabel: z.string().trim().min(1).max(40),
  listed: z.boolean(),
  purchaseEnabled: z.boolean(),
  renewalEnabled: z.boolean(),
  sortOrder: z.number().int().min(0).max(2147483647),
  formSchema: productFormSchema,
}
export const editProduct = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0)
const validateType = (
  value: {
    type: 'SUBSCRIPTION' | 'ONE_TIME'
    renewalPriceFen: number | null
    renewalEnabled: boolean
  },
  ctx: z.RefinementCtx,
) => {
  if (value.type === 'SUBSCRIPTION' && value.renewalPriceFen === null)
    ctx.addIssue({
      code: 'custom',
      path: ['renewalPriceFen'],
      message: '订阅商品必须设置续费价格',
    })
  if (
    value.type === 'ONE_TIME' &&
    (value.renewalPriceFen !== null || value.renewalEnabled)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['renewalPriceFen'],
      message: '一次性商品不能设置续费价格或启用续费',
    })
}
export const completeProduct = z.strictObject(fields).superRefine(validateType)
export const createProduct = z
  .strictObject({
    ...fields,
    description: fields.description.default(null),
    listed: fields.listed.default(false),
    purchaseEnabled: fields.purchaseEnabled.default(false),
    renewalEnabled: fields.renewalEnabled.default(false),
    sortOrder: fields.sortOrder.default(0),
    formSchema: fields.formSchema.default(emptyFormSchema),
  })
  .superRefine(validateType)
export const listProducts = z.strictObject({
  search: z.string().trim().max(120).default(''),
  archived: z.enum(['ALL', 'ACTIVE', 'ARCHIVED']).default('ALL'),
  type: z.enum(['SUBSCRIPTION', 'ONE_TIME']).optional(),
  listed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
