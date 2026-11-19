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
  servicePeriodUnit: z.enum(['DAY', 'MONTH', 'YEAR']).nullable(),
  servicePeriodCount: z.number().int().min(1).max(2147483647).nullable(),
  listed: z.boolean(),
  sortOrder: z.number().int().min(0).max(2147483647),
  formSchema: productFormSchema,
}
export const editProduct = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0)
  .superRefine((value, ctx) => {
    if (
      Object.hasOwn(value, 'servicePeriodUnit') !==
      Object.hasOwn(value, 'servicePeriodCount')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['servicePeriodUnit'],
        message: '修改结构化周期时必须同时提供单位和数量',
      })
  })
const validateType = (
  value: {
    type: 'SUBSCRIPTION' | 'ONE_TIME'
    renewalPriceFen: number | null
    servicePeriodUnit: 'DAY' | 'MONTH' | 'YEAR' | null
    servicePeriodCount: number | null
  },
  ctx: z.RefinementCtx,
) => {
  if (value.type === 'SUBSCRIPTION' && value.renewalPriceFen === null)
    ctx.addIssue({
      code: 'custom',
      path: ['renewalPriceFen'],
      message: '订阅商品必须设置续费价格',
    })
  if (value.type === 'ONE_TIME' && value.renewalPriceFen !== null)
    ctx.addIssue({
      code: 'custom',
      path: ['renewalPriceFen'],
      message: '一次性商品不能设置续费价格',
    })
  if (
    value.type === 'SUBSCRIPTION' &&
    (value.servicePeriodUnit === null || value.servicePeriodCount === null)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['servicePeriodUnit'],
      message: '订阅商品必须配置完整的结构化服务周期',
    })
  if (
    value.type === 'ONE_TIME' &&
    (value.servicePeriodUnit !== null || value.servicePeriodCount !== null)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['servicePeriodUnit'],
      message: '一次性商品不能配置订阅服务周期',
    })
}
export const completeProduct = z.strictObject(fields).superRefine(validateType)
// Only the service may select this validator for an existing NULL-pair subscription
// whose PATCH omits both period fields. It must never validate a new product.
export const legacyProduct = z.strictObject({
  ...fields,
  type: z.literal('SUBSCRIPTION'),
  renewalPriceFen: price,
  servicePeriodUnit: z.null(),
  servicePeriodCount: z.null(),
})
export const createProduct = z
  .strictObject({
    ...fields,
    description: fields.description.default(null),
    servicePeriodUnit: fields.servicePeriodUnit.default(null),
    servicePeriodCount: fields.servicePeriodCount.default(null),
    listed: fields.listed.default(false),
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
