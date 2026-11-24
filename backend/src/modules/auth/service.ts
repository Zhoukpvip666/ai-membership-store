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

const sessionData = (userId: string, token: string, now: Date) => ({
  userId,
  tokenHash: tokenHash(token),
  expiresAt: new Date(now.getTime() + SESSION_MS),
  lastSeenAt: now,
})

const invalidInvitation = () =>
  new ApiError(
    409,
    'INVITATION_INVALID',
    '邀请无效、已过期、已撤销或已使用，请联系管理员',
  )

export function authService(database: PrismaClient) {
  let dummyHash: Promise<string> | undefined
  return {
    async register(email: string, password: string, invitationToken?: string) {
      if (invitationToken)
        return claimInvitation(invitationToken, email, password)
      const passwordHash = await hashPassword(password)
      const token = newToken()
      const user = await transaction(database, async (tx) => {
        const now = new Date()
        // Keep public registration insert-only. The unique email index arbitrates concurrent claims.
        const created = await tx.user.create({
          data: {
            loginEmail: email,
            passwordHash,
            role: 'CUSTOMER',
            status: 'ACTIVE',
            activatedAt: now,
            createdByAdminId: null,
          },
          select: publicUserSelect,
        })
        await tx.session.create({ data: sessionData(created.id, token, now) })
        return created
      })
      return { token, user }
    },
    async login(email: string, password: string, requestId: string) {
      const user = await database.user.findUnique({
        where: { loginEmail: email },
      })
      dummyHash ??= hashPassword(newToken())
      const verified = await verifyPassword(
        user?.passwordHash ?? (await dummyHash),
        password,
      )
      if (!user?.passwordHash || !verified || user.status !== 'ACTIVE')
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
        await tx.session.create({ data: sessionData(user.id, token, now) })
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
  }

  async function claimInvitation(
    invitationToken: string,
    email: string,
    password: string,
  ) {
    const invitationHash = tokenHash(invitationToken)
    const target = await database.invitationToken.findUnique({
      where: { tokenHash: invitationHash },
      select: { userId: true },
    })
    if (!target) throw invalidInvitation()

    const passwordHash = await hashPassword(password)
    const token = newToken()
    const user = await transaction(database, async (tx) => {
      // Serialize activation with other writes to the same customer before
      // reading or consuming their invitation.
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${target.userId} FOR UPDATE`
      const invitation = await tx.invitationToken.findUnique({
        where: { tokenHash: invitationHash },
        include: { user: true },
      })
      const now = new Date()
      if (
        !invitation ||
        invitation.userId !== target.userId ||
        invitation.usedAt ||
        invitation.revokedAt ||
        invitation.expiresAt <= now ||
        invitation.user.role !== 'CUSTOMER' ||
        invitation.user.status !== 'PENDING_ACTIVATION' ||
        invitation.user.loginEmail !== null ||
        invitation.user.passwordHash !== null ||
        invitation.user.activatedAt !== null
      )
        throw invalidInvitation()

      const activated = await tx.user.update({
        where: { id: invitation.userId },
        data: {
          loginEmail: email,
          passwordHash,
          status: 'ACTIVE',
          activatedAt: now,
        },
        select: publicUserSelect,
      })
      const consumed = await tx.invitationToken.updateMany({
        where: {
          id: invitation.id,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: now },
      })
      if (consumed.count !== 1) throw invalidInvitation()
      await tx.invitationToken.updateMany({
        where: { userId: activated.id, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      })
      await tx.session.updateMany({
        where: { userId: activated.id, revokedAt: null },
        data: { revokedAt: now },
      })
      await tx.session.create({ data: sessionData(activated.id, token, now) })
      return activated
    })
    return { token, user }
  }
}
