import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { timezone } from '../settings/service.ts'

export const listCustomerSubscriptions = z.strictObject({
  status: z.enum(['ACTIVE', 'EXPIRED', 'TERMINATED']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

const customerSubscriptionSelect = {
  id: true,
  productNameSnapshot: true,
  termSnapshot: true,
  status: true,
  startedAt: true,
  expiresAt: true,
  renewalPriceFen: true,
  sourceOrder: {
    select: { id: true, orderNo: true, userId: true, hidden: true },
  },
} satisfies Prisma.SubscriptionSelect
type CustomerSubscriptionRow = Prisma.SubscriptionGetPayload<{
  select: typeof customerSubscriptionSelect
}>
type ReadClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'appSettings'>

export function customerSubscriptionDto(
  row: CustomerSubscriptionRow,
  userId: string,
  now: Date,
) {
  const order = row.sourceOrder
  return {
    id: row.id,
    productNameSnapshot: row.productNameSnapshot,
    termSnapshot: row.termSnapshot,
    status:
      row.status === 'ACTIVE' && row.expiresAt <= now
        ? ('EXPIRED' as const)
        : row.status,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    renewalPriceFen: row.renewalPriceFen,
    sourceOrder:
      order?.userId === userId && !order.hidden
        ? { id: order.id, orderNo: order.orderNo }
        : null,
  }
}

async function readContext(db: ReadClient) {
  const [clock, settings] = await Promise.all([
    db.$queryRaw<{ now: Date }[]>`SELECT UTC_TIMESTAMP(3) AS now`,
    db.appSettings.findUnique({ where: { id: 1 }, select: { timezone: true } }),
  ])
  const zone = timezone.safeParse(settings?.timezone)
  return {
    now: clock[0]!.now,
    businessTimezone: zone.success ? zone.data : 'Asia/Shanghai',
  }
}

export function customerSubscriptionReadService(db: PrismaClient) {
  return {
    list(userId: string, input: z.output<typeof listCustomerSubscriptions>) {
      return db.$transaction(async (tx) => {
        const { now, businessTimezone } = await readContext(tx)
        const where: Prisma.SubscriptionWhereInput = { userId }
        if (input.status === 'TERMINATED') where.status = 'TERMINATED'
        if (input.status === 'ACTIVE' || input.status === 'EXPIRED') {
          where.status = 'ACTIVE'
          where.expiresAt =
            input.status === 'ACTIVE' ? { gt: now } : { lte: now }
        }
        const [rows, total] = await Promise.all([
          tx.subscription.findMany({
            where,
            select: customerSubscriptionSelect,
            orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
            skip: (input.page - 1) * input.pageSize,
            take: input.pageSize,
          }),
          tx.subscription.count({ where }),
        ])
        return {
          items: rows.map((row) => customerSubscriptionDto(row, userId, now)),
          total,
          page: input.page,
          pageSize: input.pageSize,
          businessTimezone,
        }
      })
    },
    async detail(userId: string, id: string) {
      const row = await db.subscription.findFirst({
        where: { id, userId },
        select: customerSubscriptionSelect,
      })
      if (!row) throw new ApiError(404, 'NOT_FOUND', '订阅不存在')
      const { now, businessTimezone } = await readContext(db)
      return {
        subscription: customerSubscriptionDto(row, userId, now),
        businessTimezone,
      }
    },
  }
}
