import {
  Prisma,
  type PrismaClient,
  type Subscription,
  type SubscriptionEventType,
} from '../../generated/prisma/client.ts'
import type { z } from 'zod'
import { ApiError } from '../../http/errors.ts'
import { transaction } from '../../db/transaction.ts'
import { productFormSchema } from '../../contracts/product-form.ts'
import { parseFormData } from '../../contracts/form-data.ts'
import { adminUserSelect } from '../users/service.ts'
import { mutation } from './idempotency.ts'
import type * as schemas from './schemas.ts'

type Tx = Prisma.TransactionClient
const missing = () => new ApiError(404, 'NOT_FOUND', '订阅不存在')
const conflict = () =>
  new ApiError(
    409,
    'SUBSCRIPTION_CONFLICT',
    '订阅版本已变化、已到期或已终止，请刷新后重试',
  )
const relations = {
  user: { select: adminUserSelect },
  product: { select: { id: true, archivedAt: true } },
} as const
async function clock(tx: Tx) {
  const rows = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT UTC_TIMESTAMP(3) AS now`
  return rows[0]!.now
}
// Record every mutable field while redacting customer-entered content. Full data is
// kept only in the protected subscription, never copied into history/audit logs.
function history(s: Subscription): Prisma.InputJsonObject {
  return {
    id: s.id,
    userId: s.userId,
    productId: s.productId,
    sourceType: s.sourceType,
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    renewalPriceFen: s.renewalPriceFen,
    status: s.status,
    version: s.version,
    terminatedAt: s.terminatedAt?.toISOString() ?? null,
    terminationReason: s.terminationReason,
    note: s.note === null ? null : '[REDACTED]',
    formData: Object.fromEntries(
      Object.keys(s.formData as object).map((key) => [key, '[REDACTED]']),
    ),
  }
}
async function record(
  tx: Tx,
  before: Subscription | null,
  after: Subscription,
  eventTypes: SubscriptionEventType[],
  actorId: string | null,
  reason: string | null,
  requestId?: string,
) {
  const actorType = actorId ? 'ADMIN' : 'SYSTEM'
  for (const eventType of eventTypes)
    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: after.id,
        actorAdminId: actorId,
        actorType,
        eventType,
        reason,
        oldStartedAt: before?.startedAt,
        newStartedAt: after.startedAt,
        oldExpiresAt: before?.expiresAt,
        newExpiresAt: after.expiresAt,
        beforeJson: before ? history(before) : Prisma.DbNull,
        afterJson: history(after),
      },
    })
  await tx.adminAuditLog.create({
    data: {
      actorAdminId: actorId,
      actorType,
      action: 'SUBSCRIPTION_' + eventTypes[0],
      entityType: 'Subscription',
      entityId: after.id,
      reason,
      requestId,
      beforeJson: before ? history(before) : Prisma.DbNull,
      afterJson: history(after),
    },
  })
}
async function current(tx: Tx, id: string, version: number) {
  const subscription = await tx.subscription.findUnique({ where: { id } })
  if (!subscription) throw missing()
  if (subscription.version !== version || subscription.status !== 'ACTIVE')
    throw conflict()
  return subscription
}

export function subscriptionService(db: PrismaClient) {
  return {
    async list(input: z.output<typeof schemas.listSubscriptions>) {
      const now = await clock(db)
      const expiry =
        input.expiry === 'UPCOMING'
          ? { gt: now, lte: new Date(now.getTime() + 7 * 86400000) }
          : input.expiry === 'EXPIRED'
            ? { lte: now }
            : undefined
      const where: Prisma.SubscriptionWhereInput = {
        userId: input.userId,
        productId: input.productId,
        status: input.status,
        sourceType: input.sourceType,
        AND: [
          { expiresAt: expiry },
          { expiresAt: { gte: input.from, lte: input.to } },
          {
            OR: [
              { productNameSnapshot: { contains: input.search } },
              {
                user: {
                  OR: [
                    { username: { contains: input.search } },
                    { adminLabel: { contains: input.search } },
                    { loginEmail: { contains: input.search } },
                  ],
                },
              },
            ],
          },
        ],
      }
      const [items, total] = await db.$transaction([
        db.subscription.findMany({
          where,
          include: relations,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.subscription.count({ where }),
      ])
      return {
        items,
        total,
        page: input.page,
        pageSize: input.pageSize,
        serverNow: now,
      }
    },
    async detail(id: string) {
      const subscription = await db.subscription.findUnique({
        where: { id },
        include: relations,
      })
      if (!subscription) throw missing()
      return subscription
    },
    async events(id: string, input: z.output<typeof schemas.listEvents>) {
      if (
        !(await db.subscription.findUnique({
          where: { id },
          select: { id: true },
        }))
      )
        throw missing()
      const where = { subscriptionId: id }
      const [items, total] = await db.$transaction([
        db.subscriptionEvent.findMany({
          where,
          include: { actorAdmin: { select: adminUserSelect } },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        db.subscriptionEvent.count({ where }),
      ])
      return { items, total, page: input.page, pageSize: input.pageSize }
    },
    create(
      input: z.output<typeof schemas.createSubscription>,
      actorId: string,
      requestId: string,
      key?: string,
    ) {
      return mutation(
        db,
        actorId,
        key,
        'subscriptions:create',
        input,
        async (tx) => {
          const user = await tx.user.findUnique({ where: { id: input.userId } })
          if (!user || user.role !== 'CUSTOMER' || user.status === 'DISABLED')
            throw new ApiError(
              409,
              'CUSTOMER_UNAVAILABLE',
              '请选择未停用的客户，可使用待激活客户',
            )
          const product = await tx.product.findUnique({
            where: { id: input.productId },
          })
          if (!product || product.archivedAt || product.type !== 'SUBSCRIPTION')
            throw new ApiError(
              409,
              'PRODUCT_UNAVAILABLE',
              '请选择未归档的订阅商品，上架状态不限',
            )
          const schema = productFormSchema.parse(product.formSchema)
          const values = parseFormData(schema, input.formData)
          const subscription = await tx.subscription.create({
            data: {
              userId: input.userId,
              productId: product.id,
              sourceType: 'ADMIN',
              createdByAdminId: actorId,
              startedAt: input.startedAt,
              expiresAt: input.expiresAt,
              renewalPriceFen: input.renewalPriceFen,
              note: input.note ?? null,
              formData: values,
              status: 'ACTIVE',
              version: 1,
              productNameSnapshot: product.name,
              productDescriptionSnapshot: product.description,
              productTypeSnapshot: product.type,
              priceSnapshotFen: product.priceFen,
              termSnapshot: product.termLabel,
              formSchemaSnapshot: schema,
            },
          })
          await record(
            tx,
            null,
            subscription,
            ['CREATED'],
            actorId,
            null,
            requestId,
          )
          return { subscription }
        },
      )
    },
    edit(
      id: string,
      input: z.output<typeof schemas.editSubscription>,
      actorId: string,
      requestId: string,
      key?: string,
    ) {
      return mutation(
        db,
        actorId,
        key,
        'subscriptions:' + id + ':edit',
        input,
        async (tx) => {
          const before = await current(tx, id, input.version)
          const startedAt = input.startedAt ?? before.startedAt
          const expiresAt = input.expiresAt ?? before.expiresAt
          if (startedAt >= expiresAt)
            throw new ApiError(400, 'INVALID_INPUT', '开始时间必须早于到期时间')
          const values =
            input.formData === undefined
              ? undefined
              : parseFormData(
                  productFormSchema.parse(before.formSchemaSnapshot),
                  input.formData,
                )
          const changed = await tx.$executeRaw`UPDATE Subscription SET
          startedAt = ${startedAt}, expiresAt = ${expiresAt},
          renewalPriceFen = ${input.renewalPriceFen ?? before.renewalPriceFen},
          formData = ${JSON.stringify(values ?? before.formData)},
          note = ${input.note === undefined ? before.note : input.note},
          version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${id} AND version = ${input.version} AND status = 'ACTIVE' AND expiresAt > UTC_TIMESTAMP(3)`
          if (changed !== 1) throw conflict()
          const after = await tx.subscription.findUniqueOrThrow({
            where: { id },
          })
          const types: SubscriptionEventType[] = ['UPDATED']
          if (
            before.startedAt.getTime() !== after.startedAt.getTime() ||
            before.expiresAt.getTime() !== after.expiresAt.getTime()
          )
            types.push('EXPIRY_ADJUSTED')
          if (before.renewalPriceFen !== after.renewalPriceFen)
            types.push('PRICE_CHANGED')
          if (
            values !== undefined &&
            JSON.stringify(before.formData) !== JSON.stringify(after.formData)
          )
            types.push('FORM_DATA_UPDATED')
          await record(
            tx,
            before,
            after,
            types,
            actorId,
            input.reason,
            requestId,
          )
          return { subscription: after }
        },
      )
    },
    renew(
      id: string,
      input: z.output<typeof schemas.renewSubscription>,
      actorId: string,
      requestId: string,
      key?: string,
    ) {
      return mutation(
        db,
        actorId,
        key,
        'subscriptions:' + id + ':renew',
        input,
        async (tx) => {
          const before = await current(tx, id, input.version)
          const product = await tx.product.findUniqueOrThrow({
            where: { id: before.productId },
            select: { archivedAt: true },
          })
          if (product.archivedAt)
            throw new ApiError(
              409,
              'PRODUCT_ARCHIVED',
              '商品已归档，不能续订；现有订阅仍可维护',
            )
          if (input.newExpiresAt <= before.startedAt)
            throw new ApiError(
              400,
              'INVALID_INPUT',
              '新到期时间必须晚于开始时间和当前时间',
            )
          const changed =
            await tx.$executeRaw`UPDATE Subscription SET expiresAt = ${input.newExpiresAt},
          renewalPriceFen = ${input.renewalPriceFen ?? before.renewalPriceFen},
          version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${id} AND version = ${input.version} AND status = 'ACTIVE'
          AND expiresAt > UTC_TIMESTAMP(3) AND ${input.newExpiresAt} > UTC_TIMESTAMP(3)`
          if (changed !== 1) throw conflict()
          const after = await tx.subscription.findUniqueOrThrow({
            where: { id },
          })
          await record(
            tx,
            before,
            after,
            ['RENEWED'],
            actorId,
            input.reason,
            requestId,
          )
          return { subscription: after }
        },
      )
    },
    terminate(
      id: string,
      input: z.output<typeof schemas.terminateSubscription>,
      actorId: string,
      requestId: string,
      key?: string,
    ) {
      return mutation(
        db,
        actorId,
        key,
        'subscriptions:' + id + ':terminate',
        input,
        async (tx) => {
          const before = await current(tx, id, input.version)
          const changed =
            await tx.$executeRaw`UPDATE Subscription SET status = 'TERMINATED',
          terminatedAt = UTC_TIMESTAMP(3), terminationReason = ${input.reason},
          version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${id} AND version = ${input.version} AND status = 'ACTIVE'`
          if (changed !== 1) throw conflict()
          const after = await tx.subscription.findUniqueOrThrow({
            where: { id },
          })
          await record(
            tx,
            before,
            after,
            ['TERMINATED'],
            actorId,
            input.reason,
            requestId,
          )
          return { subscription: after }
        },
      )
    },
    async autoTerminate() {
      const candidates = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM Subscription
        WHERE status = 'ACTIVE' AND expiresAt <= UTC_TIMESTAMP(3) ORDER BY expiresAt, id LIMIT 100`
      let count = 0
      for (const candidate of candidates)
        count += await transaction(db, async (tx) => {
          const before = await tx.subscription.findUnique({
            where: { id: candidate.id },
          })
          if (!before || before.status !== 'ACTIVE') return 0
          const changed =
            await tx.$executeRaw`UPDATE Subscription SET status = 'TERMINATED',
          terminatedAt = UTC_TIMESTAMP(3), terminationReason = '订阅到期',
          version = version + 1, updatedAt = UTC_TIMESTAMP(3)
          WHERE id = ${before.id} AND version = ${before.version} AND status = 'ACTIVE'
          AND expiresAt <= UTC_TIMESTAMP(3)`
          if (changed !== 1) return 0
          const after = await tx.subscription.findUniqueOrThrow({
            where: { id: before.id },
          })
          await record(tx, before, after, ['AUTO_TERMINATED'], null, '订阅到期')
          return 1
        })
      return count
    },
  }
}
