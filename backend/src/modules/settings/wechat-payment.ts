import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import { encodeWechatImage } from './wechat-image.ts'
import { wechatImageStorage } from './wechat-storage.ts'

const settingsSelect = {
  wechatPayEnabled: true,
  wechatQrImageKey: true,
} as const
type PaymentSettings = Prisma.AppSettingsGetPayload<{
  select: typeof settingsSelect
}>

export const wechatQrPath = '/settings/wechat-qr'
const imageUrl = '/api/v1/admin' + wechatQrPath

function describe(settings: PaymentSettings) {
  return {
    enabled: settings.wechatPayEnabled,
    imageUrl: settings.wechatQrImageKey ? imageUrl : null,
  }
}

async function readSettings(db: Pick<Prisma.TransactionClient, 'appSettings'>) {
  const settings = await db.appSettings.findUnique({
    where: { id: 1 },
    select: settingsSelect,
  })
  if (!settings)
    throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '系统设置尚未初始化')
  return settings
}

async function lockSettings(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM AppSettings WHERE id = 1 FOR UPDATE`
  return readSettings(tx)
}

type AuditActor = { actorAdminId: string; requestId: string }
async function audit(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  action: string,
  before: PaymentSettings,
  after: PaymentSettings,
) {
  const state = (settings: PaymentSettings) => ({
    enabled: settings.wechatPayEnabled,
    hasImage: Boolean(settings.wechatQrImageKey),
  })
  await tx.adminAuditLog.create({
    data: {
      ...actor,
      action,
      entityType: 'AppSettings',
      entityId: '1',
      beforeJson: state(before),
      afterJson: state(after),
    },
  })
}

export function wechatPaymentService(
  db: PrismaClient,
  storageDirectory?: string,
) {
  const storage = wechatImageStorage(storageDirectory)
  return {
    async get() {
      return describe(await readSettings(db))
    },
    async readImage() {
      const settings = await readSettings(db)
      if (!settings.wechatQrImageKey)
        throw new ApiError(
          404,
          'WECHAT_QR_NOT_CONFIGURED',
          '尚未上传微信收款码',
        )
      return storage.read(settings.wechatQrImageKey)
    },
    async readEnabledImage(tx: Prisma.TransactionClient) {
      const settings = await readSettings(tx)
      if (!settings.wechatPayEnabled || !settings.wechatQrImageKey)
        throw new ApiError(404, 'WECHAT_QR_UNAVAILABLE', '商家暂未开放扫码收款')
      return storage.read(settings.wechatQrImageKey)
    },
    async upload(input: unknown, actor: AuditActor) {
      // Persist an immutable file before publishing its reference. Keep previous
      // and unpublished files so rollback or an uncertain commit cannot break reads.
      const key = await storage.write(await encodeWechatImage(input))
      return transaction(db, async (tx) => {
        const current = await lockSettings(tx)
        const saved = await tx.appSettings.update({
          where: { id: 1 },
          data: { wechatQrImageKey: key },
          select: settingsSelect,
        })
        await audit(
          tx,
          actor,
          current.wechatQrImageKey
            ? 'WECHAT_QR_REPLACED'
            : 'WECHAT_QR_UPLOADED',
          current,
          saved,
        )
        return describe(saved)
      })
    },
    setEnabled(enabled: boolean, actor: AuditActor) {
      return transaction(db, async (tx) => {
        const current = await lockSettings(tx)
        if (enabled) {
          if (!current.wechatQrImageKey)
            throw new ApiError(
              409,
              'WECHAT_QR_NOT_CONFIGURED',
              '请先上传微信收款码',
            )
          await storage.read(current.wechatQrImageKey)
        }
        if (current.wechatPayEnabled === enabled) return describe(current)
        const saved = await tx.appSettings.update({
          where: { id: 1 },
          data: { wechatPayEnabled: enabled },
          select: settingsSelect,
        })
        await audit(
          tx,
          actor,
          enabled ? 'WECHAT_PAYMENT_ENABLED' : 'WECHAT_PAYMENT_DISABLED',
          current,
          saved,
        )
        return describe(saved)
      })
    },
  }
}
