import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'

const pageNumber = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(max))

export const catalogQuery = z.strictObject({
  search: z.string().trim().max(120).default(''),
  type: z.enum(['SUBSCRIPTION', 'ONE_TIME']).optional(),
  page: pageNumber(10000).default(1),
  pageSize: pageNumber(100).default(20),
})
export const catalogDetailQuery = z.strictObject({})

const publicProductSelect = {
  slug: true,
  name: true,
  description: true,
  type: true,
  priceFen: true,
  renewalPriceFen: true,
  termLabel: true,
  servicePeriodUnit: true,
  servicePeriodCount: true,
} as const satisfies Prisma.ProductSelect

const publicListing = { listed: true, archivedAt: null } as const
const missing = () => new ApiError(404, 'NOT_FOUND', '商品不存在')

export function publicCatalog(database: PrismaClient) {
  return {
    async list({
      search,
      type,
      page,
      pageSize,
    }: z.output<typeof catalogQuery>) {
      const where: Prisma.ProductWhereInput = {
        ...publicListing,
        type,
        name: search
          ? { contains: search.replace(/[\\%_]/g, '\\$&') }
          : undefined,
      }
      const [items, total] = await database.$transaction([
        database.product.findMany({
          where,
          select: publicProductSelect,
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        database.product.count({ where }),
      ])
      return { items, total, page, pageSize }
    },
    async detail(slug: string) {
      if (!slug || slug.length > 100) throw missing()
      const product = await database.product.findUnique({
        where: { slug, ...publicListing },
        select: publicProductSelect,
      })
      if (!product) throw missing()
      return product
    },
  }
}
