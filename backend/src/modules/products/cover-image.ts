import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts'
import { defaultCoverStorage } from '../../config/image-directories.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'
import { encodeImage } from '../../storage/image.ts'
import { immutableImageStorage } from '../../storage/immutable-images.ts'

export const maxCoverBytes = 4 * 1024 * 1024
const absent = () => new ApiError(404, 'NOT_FOUND', '商品主图不存在')
const unavailable = () =>
  new ApiError(503, 'PRODUCT_COVER_STORAGE_UNAVAILABLE', '商品主图存储暂不可用')

function encodeCover(input: unknown) {
  return encodeImage(input, {
    maxBytes: maxCoverBytes,
    maxDimension: 4096,
    output: 'webp',
    invalid: () =>
      new ApiError(
        400,
        'PRODUCT_COVER_INVALID',
        '请上传有效的 PNG、JPEG 或 WebP 图片，宽高均不得超过 4096 像素',
      ),
    tooLarge: () =>
      new ApiError(413, 'PAYLOAD_TOO_LARGE', '商品主图不得超过 4 MB'),
  })
}

function coverImageUrl(path: string, key: string | null) {
  if (!key) return null
  // The revision refreshes mounted clients. Reads always resolve the current reference.
  const revision = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return '/api/v1/' + path + '/cover-image?v=' + revision
}

export const adminCoverUrl = (id: string, key: string | null) =>
  coverImageUrl('admin/products/' + encodeURIComponent(id), key)

export const publicCoverUrl = (slug: string, key: string | null) =>
  coverImageUrl('catalog/products/' + encodeURIComponent(slug), key)

const select = {
  coverImageKey: true,
  archivedAt: true,
  updatedAt: true,
} as const
type Actor = { actorAdminId: string; requestId: string }

async function editableProduct(db: Prisma.TransactionClient, id: string) {
  const product = await db.product.findUnique({ where: { id }, select })
  if (!product) throw new ApiError(404, 'NOT_FOUND', '商品不存在')
  if (product.archivedAt)
    throw new ApiError(409, 'PRODUCT_ARCHIVED', '归档商品不能编辑')
  return product
}

export function productCoverService(
  db: PrismaClient,
  directory = defaultCoverStorage,
) {
  const storage = immutableImageStorage(
    directory,
    '.webp',
    maxCoverBytes,
    unavailable,
  )

  async function change(id: string, key: string | null, actor: Actor) {
    return transaction(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM Product WHERE id = ${id} FOR UPDATE`
      const before = await editableProduct(tx, id)
      if (before.coverImageKey === key)
        return {
          coverImageUrl: adminCoverUrl(id, key),
          updatedAt: before.updatedAt,
        }

      const saved = await tx.product.update({
        where: { id },
        data: {
          coverImageKey: key,
          updatedAt: new Date(
            Math.max(Date.now(), before.updatedAt.getTime() + 1),
          ),
        },
        select,
      })
      await tx.adminAuditLog.create({
        data: {
          ...actor,
          action: !key
            ? 'PRODUCT_COVER_REMOVED'
            : before.coverImageKey
              ? 'PRODUCT_COVER_REPLACED'
              : 'PRODUCT_COVER_UPLOADED',
          entityType: 'Product',
          entityId: id,
          beforeJson: { hasImage: Boolean(before.coverImageKey) },
          afterJson: { hasImage: Boolean(saved.coverImageKey) },
        },
      })
      return {
        coverImageUrl: adminCoverUrl(id, saved.coverImageKey),
        updatedAt: saved.updatedAt,
      }
    })
  }

  return {
    async upload(id: string, input: unknown, actor: Actor) {
      await editableProduct(db, id)
      // Keep old and unpublished immutable files across rollbacks and lost acknowledgements.
      const key = await storage.write(await encodeCover(input))
      return change(id, key, actor)
    },
    remove(id: string, actor: Actor) {
      return change(id, null, actor)
    },
    async readAdmin(id: string) {
      const product = await db.product.findUnique({ where: { id }, select })
      if (!product?.coverImageKey) throw absent()
      return storage.read(product.coverImageKey)
    },
    async readPublic(slug: string) {
      if (!slug || slug.length > 100) throw absent()
      const product = await db.product.findUnique({
        where: { slug, listed: true, archivedAt: null },
        select: { coverImageKey: true },
      })
      if (!product?.coverImageKey) throw absent()
      return storage.read(product.coverImageKey).catch(() => {
        throw absent()
      })
    },
  }
}
