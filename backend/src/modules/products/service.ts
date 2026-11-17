import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import {
  completeProduct,
  type createProduct,
  type editProduct,
  type listProducts,
} from './schemas.ts'

const select = {
  id: true,
  slug: true,
  name: true,
  description: true,
  type: true,
  priceFen: true,
  renewalPriceFen: true,
  termLabel: true,
  targetField: true,
  listed: true,
  sortOrder: true,
  formSchema: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const
const missing = () => new ApiError(404, 'NOT_FOUND', '商品不存在')
const snapshot = (product: {
  type: string
  priceFen: number
  renewalPriceFen: number | null
  listed: boolean
  sortOrder: number
}) => ({
  type: product.type,
  priceFen: product.priceFen,
  renewalPriceFen: product.renewalPriceFen,
  listed: product.listed,
  sortOrder: product.sortOrder,
})
function audit(
  tx: Prisma.TransactionClient,
  actorId: string,
  requestId: string,
  action: string,
  entityId: string,
  afterJson: Prisma.InputJsonObject,
  beforeJson?: Prisma.InputJsonObject,
) {
  return tx.adminAuditLog.create({
    data: {
      actorAdminId: actorId,
      requestId,
      action,
      entityType: 'Product',
      entityId,
      afterJson,
      beforeJson,
    },
  })
}
export function productService(database: PrismaClient) {
  return {
    async list(input: z.output<typeof listProducts>) {
      const where = {
        name: { contains: input.search },
        type: input.type,
        listed: input.listed,
        ...(input.archived === 'ACTIVE'
          ? { archivedAt: null }
          : input.archived === 'ARCHIVED'
            ? { archivedAt: { not: null } }
            : {}),
      }
      const [items, total] = await database.$transaction([
        database.product.findMany({
          where,
          select,
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        database.product.count({ where }),
      ])
      return { items, total, page: input.page, pageSize: input.pageSize }
    },
    async detail(id: string) {
      const product = await database.product.findUnique({
        where: { id },
        select,
      })
      if (!product) throw missing()
      return product
    },
    create(
      input: z.output<typeof createProduct>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const product = await tx.product.create({
          data: {
            ...input,
            slug: 'product-' + randomUUID(),
            targetField: 'NONE',
          },
          select,
        })
        await audit(tx, actorId, requestId, 'PRODUCT_CREATED', product.id, {
          ...snapshot(product),
          fieldCount: input.formSchema.fields.length,
        })
        return product
      })
    },
    edit(
      id: string,
      input: z.output<typeof editProduct>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const current = await tx.product.findUnique({ where: { id }, select })
        if (!current) throw missing()
        if (current.archivedAt)
          throw new ApiError(409, 'PRODUCT_ARCHIVED', '归档商品不能编辑')
        // Validate the complete merged record, not just individual PATCH fields.
        const data = completeProduct.parse({
          name: current.name,
          description: current.description,
          type: current.type,
          priceFen: current.priceFen,
          renewalPriceFen: current.renewalPriceFen,
          termLabel: current.termLabel,
          listed: current.listed,
          sortOrder: current.sortOrder,
          formSchema: current.formSchema,
          ...input,
        })
        const product = await tx.product.update({ where: { id }, data, select })
        await audit(
          tx,
          actorId,
          requestId,
          'PRODUCT_UPDATED',
          id,
          {
            ...snapshot(product),
            fields: Object.keys(input),
            fieldCount: data.formSchema.fields.length,
          },
          snapshot(current),
        )
        return product
      })
    },
    archive(id: string, actorId: string, requestId: string) {
      return transaction(database, async (tx) => {
        const current = await tx.product.findUnique({ where: { id }, select })
        if (!current) throw missing()
        if (current.archivedAt) return current
        const product = await tx.product.update({
          where: { id },
          data: { listed: false, archivedAt: new Date() },
          select,
        })
        await audit(
          tx,
          actorId,
          requestId,
          'PRODUCT_ARCHIVED',
          id,
          { listed: false, archivedAt: product.archivedAt!.toISOString() },
          { listed: current.listed, archivedAt: null },
        )
        return product
      })
    },
  }
}
