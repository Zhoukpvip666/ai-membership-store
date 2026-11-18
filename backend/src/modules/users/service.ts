import type { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import { INVITATION_MS, newToken, tokenHash } from '../auth/security.ts'
import type {
  createCustomer,
  editCustomer,
  listCustomers,
  changeStatus,
} from './schemas.ts'

export const publicUserSelect = {
  id: true,
  username: true,
  loginEmail: true,
  notificationEmail: true,
  role: true,
  status: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const
export const adminUserSelect = {
  ...publicUserSelect,
  adminLabel: true,
} as const
const counts = { select: { orders: true, subscriptions: true } } as const
const invitationSelect = {
  id: true,
  createdAt: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
} as const
const missing = () => new ApiError(404, 'NOT_FOUND', '客户或邀请不存在')

export function customerService(database: PrismaClient, appBaseUrl: string) {
  return {
    async list(input: z.output<typeof listCustomers>) {
      const where = {
        role: 'CUSTOMER' as const,
        status: input.status,
        OR: [
          { adminLabel: { contains: input.search } },
          { username: { contains: input.search } },
          { loginEmail: { contains: input.search } },
        ],
      }
      const [items, total] = await database.$transaction([
        database.user.findMany({
          where,
          select: { ...adminUserSelect, _count: counts },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        database.user.count({ where }),
      ])
      return { items, total, page: input.page, pageSize: input.pageSize }
    },
    async detail(userId: string) {
      const user = await database.user.findFirst({
        where: { id: userId, role: 'CUSTOMER' },
        select: {
          ...adminUserSelect,
          _count: counts,
          invitations: {
            select: invitationSelect,
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      })
      if (!user) throw missing()
      return user
    },
    create(
      input: z.output<typeof createCustomer>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const user = await tx.user.create({
          data: {
            ...input,
            notificationEmail: input.notificationEmail ?? null,
            role: 'CUSTOMER',
            status: 'PENDING_ACTIVATION',
            createdByAdminId: actorId,
          },
          select: adminUserSelect,
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'CUSTOMER_CREATED',
            entityType: 'User',
            entityId: user.id,
            afterJson: { role: user.role, status: user.status },
            requestId,
          },
        })
        return user
      })
    },
    edit(
      userId: string,
      input: z.output<typeof editCustomer>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        if (
          !(await tx.user.findFirst({
            where: { id: userId, role: 'CUSTOMER' },
            select: { id: true },
          }))
        )
          throw missing()
        const user = await tx.user.update({
          where: { id: userId },
          data: input,
          select: adminUserSelect,
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'CUSTOMER_UPDATED',
            entityType: 'User',
            entityId: user.id,
            afterJson: { fields: Object.keys(input) },
            requestId,
          },
        })
        return user
      })
    },
    status(
      userId: string,
      input: z.output<typeof changeStatus>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: userId, role: 'CUSTOMER' },
        })
        if (!user) throw missing()
        const status = input.disabled
          ? 'DISABLED'
          : user.activatedAt && user.passwordHash
            ? 'ACTIVE'
            : 'PENDING_ACTIVATION'
        if (status === user.status)
          throw new ApiError(409, 'CONFLICT', '账户已经处于该状态')
        const updated = await tx.user.update({
          where: { id: userId },
          data: { status },
          select: adminUserSelect,
        })
        if (input.disabled) {
          const now = new Date()
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now },
          })
          await tx.invitationToken.updateMany({
            where: { userId, usedAt: null, revokedAt: null },
            data: { revokedAt: now },
          })
        }
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: input.disabled ? 'CUSTOMER_DISABLED' : 'CUSTOMER_RESTORED',
            entityType: 'User',
            entityId: userId,
            beforeJson: { status: user.status },
            afterJson: { status },
            reason: input.reason,
            requestId,
          },
        })
        return updated
      })
    },
    issue(userId: string, actorId: string, requestId: string) {
      const token = newToken()
      return transaction(database, async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: userId, role: 'CUSTOMER' },
        })
        if (!user) throw missing()
        if (
          user.status !== 'PENDING_ACTIVATION' ||
          user.passwordHash ||
          user.activatedAt
        )
          throw new ApiError(409, 'CONFLICT', '仅待激活客户可以生成邀请')
        const now = new Date()
        await tx.invitationToken.updateMany({
          where: { userId, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        })
        const invitation = await tx.invitationToken.create({
          data: {
            userId,
            tokenHash: tokenHash(token),
            expiresAt: new Date(now.getTime() + INVITATION_MS),
            createdByAdminId: actorId,
          },
          select: invitationSelect,
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'INVITATION_ISSUED',
            entityType: 'InvitationToken',
            entityId: invitation.id,
            afterJson: {
              userId,
              expiresAt: invitation.expiresAt.toISOString(),
            },
            requestId,
          },
        })
        const url = new URL('/activate', appBaseUrl)
        url.hash = token
        return { invitation, url: url.toString() }
      })
    },
    revoke(invitationId: string, actorId: string, requestId: string) {
      return transaction(database, async (tx) => {
        const invitation = await tx.invitationToken.findUnique({
          where: { id: invitationId },
          include: { user: { select: { role: true } } },
        })
        if (!invitation || invitation.user.role !== 'CUSTOMER') throw missing()
        if (invitation.usedAt || invitation.revokedAt)
          throw new ApiError(409, 'CONFLICT', '邀请已使用或已撤销')
        await tx.invitationToken.update({
          where: { id: invitationId },
          data: { revokedAt: new Date() },
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            action: 'INVITATION_REVOKED',
            entityType: 'InvitationToken',
            entityId: invitationId,
            requestId,
          },
        })
      })
    },
  }
}
