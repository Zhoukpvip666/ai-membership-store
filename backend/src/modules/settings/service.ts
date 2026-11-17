import { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'

export const editSettings = z
  .strictObject({
    storeName: z.string().trim().min(1).max(80).optional(),
    ownerEmail: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email().max(254))
      .optional(),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value })
          return !/^[+-]/.test(value)
        } catch {
          return false
        }
      }, '请输入有效的 IANA 时区')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
export function settingsService(database: PrismaClient) {
  return {
    async get() {
      const settings = await database.appSettings.findUnique({
        where: { id: 1 },
      })
      if (!settings)
        throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '系统设置尚未初始化')
      return settings
    },
    edit(
      input: z.output<typeof editSettings>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const current = await tx.appSettings.findUnique({ where: { id: 1 } })
        if (!current)
          throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '系统设置尚未初始化')
        const settings = await tx.appSettings.update({
          where: { id: 1 },
          data: input,
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            requestId,
            action: 'SETTINGS_UPDATED',
            entityType: 'AppSettings',
            entityId: '1',
            beforeJson: { timezone: current.timezone },
            afterJson: {
              fields: Object.keys(input),
              timezone: settings.timezone,
            },
          },
        })
        return settings
      })
    },
  }
}
