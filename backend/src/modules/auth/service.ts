import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import { publicUserSelect } from '../users/service.ts'
import {
  hashPassword,
  newToken,
  SESSION_MS,
  tokenHash,
  tokenPattern,
  verifyPassword,
} from './security.ts'

const invalidInvitation = () =>
  new ApiError(
    409,
    'INVITATION_INVALID',
    '邀请无效、已过期、已撤销或已使用，请联系管理员',
  )

export function authService(database: PrismaClient) {
  let dummyHash: Promise<string> | undefined
  return {
    async login(email: string, password: string, requestId: string) {
      const user = await database.user.findUnique({
        where: { loginEmail: email },
      })
      dummyHash ??= hashPassword(newToken())
      const verified = await verifyPassword(
        user?.passwordHash ?? (await dummyHash),
        password,
      )
      if (!user || !verified || user.status !== 'ACTIVE')
        throw new ApiError(
          401,
          'INVALID_CREDENTIALS',
          '邮箱或密码错误，或账户尚不可用',
        )
      const token = newToken()
      const account = await transaction(database, async (tx) => {
        const current = await tx.user.findUnique({
          where: { id: user.id },
          select: { ...publicUserSelect, passwordHash: true },
        })
        if (
          !current ||
          current.status !== 'ACTIVE' ||
          current.passwordHash !== user.passwordHash
        )
          throw new ApiError(
            401,
            'INVALID_CREDENTIALS',
            '邮箱或密码错误，或账户尚不可用',
          )
        const now = new Date()
        await tx.session.create({
          data: {
            userId: user.id,
            tokenHash: tokenHash(token),
            expiresAt: new Date(now.getTime() + SESSION_MS),
            lastSeenAt: now,
          },
        })
        if (current.role === 'ADMIN')
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: current.id,
              action: 'ADMIN_LOGGED_IN',
              entityType: 'User',
              entityId: current.id,
              requestId,
            },
          })
        const { passwordHash: _passwordHash, ...safe } = current
        void _passwordHash
        return safe
      })
      return { token, user: account }
    },
    async resolve(token: string | undefined, allowPending = false) {
      if (!token || !tokenPattern.test(token)) return null
      const session = await database.session.findUnique({
        where: { tokenHash: tokenHash(token) },
        include: { user: { select: publicUserSelect } },
      })
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        (session.user.status !== 'ACTIVE' &&
          !(allowPending && session.user.status === 'PENDING_ACTIVATION'))
      )
        return null
      return { sessionId: session.id, user: session.user }
    },
    async logout(token: string | undefined, requestId: string) {
      if (!token || !tokenPattern.test(token)) return
      await transaction(database, async (tx) => {
        const session = await tx.session.findUnique({
          where: { tokenHash: tokenHash(token) },
          include: { user: { select: { role: true } } },
        })
        if (!session || session.revokedAt) return
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        })
        if (session.user.role === 'ADMIN')
          await tx.adminAuditLog.create({
            data: {
              actorAdminId: session.userId,
              action: 'ADMIN_LOGGED_OUT',
              entityType: 'User',
              entityId: session.userId,
              requestId,
            },
          })
      })
    },
    async activate(token: string, password: string) {
      const passwordHash = await hashPassword(password)
      await transaction(database, async (tx) => {
        const invitation = await tx.invitationToken.findUnique({
          where: { tokenHash: tokenHash(token) },
          include: { user: true },
        })
        const now = new Date()
        if (
          !invitation ||
          invitation.usedAt ||
          invitation.revokedAt ||
          invitation.expiresAt <= now ||
          invitation.user.role !== 'CUSTOMER' ||
          invitation.user.status !== 'PENDING_ACTIVATION' ||
          invitation.user.passwordHash ||
          invitation.user.activatedAt
        )
          throw invalidInvitation()
        const consumed = await tx.invitationToken.updateMany({
          where: {
            id: invitation.id,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        })
        if (consumed.count !== 1) throw invalidInvitation()
        const activated = await tx.user.updateMany({
          where: {
            id: invitation.userId,
            role: 'CUSTOMER',
            status: 'PENDING_ACTIVATION',
            passwordHash: null,
            activatedAt: null,
          },
          data: { passwordHash, status: 'ACTIVE', activatedAt: now },
        })
        if (activated.count !== 1) throw invalidInvitation()
        await tx.invitationToken.updateMany({
          where: { userId: invitation.userId, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        })
        await tx.session.updateMany({
          where: { userId: invitation.userId, revokedAt: null },
          data: { revokedAt: now },
        })
      })
    },
  }
}
