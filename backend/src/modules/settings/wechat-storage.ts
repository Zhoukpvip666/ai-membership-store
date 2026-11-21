import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from '../../http/errors.ts'
import { maxQrBytes } from './wechat-image.ts'

const defaultDirectory = fileURLToPath(
  new URL('../../../../.local-data/wechat-qr/', import.meta.url),
)
const imageKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.png$/

const storageUnavailable = () =>
  new ApiError(
    503,
    'WECHAT_QR_STORAGE_UNAVAILABLE',
    '收款码存储暂不可用，请检查存储配置',
  )

export function wechatImageStorage(directory = defaultDirectory) {
  return {
    async write(bytes: Buffer) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const key = randomUUID() + '.png'
        const file = await open(join(directory, key), 'wx', 0o600)
        try {
          await file.writeFile(bytes)
          await file.sync()
        } finally {
          await file.close()
        }
        return key
      } catch {
        throw storageUnavailable()
      }
    },
    async read(key: string) {
      if (!imageKey.test(key)) throw storageUnavailable()
      try {
        const file = join(await realpath(directory), key)
        const status = await lstat(file)
        if (!status.isFile() || status.size < 1 || status.size > maxQrBytes)
          throw storageUnavailable()
        const handle = await open(
          file,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        )
        try {
          const opened = await handle.stat()
          if (opened.dev !== status.dev || opened.ino !== status.ino)
            throw storageUnavailable()
          const bytes = Buffer.alloc(status.size + 1)
          let read = 0
          while (read < bytes.length) {
            const { bytesRead } = await handle.read(
              bytes,
              read,
              bytes.length - read,
              read,
            )
            if (!bytesRead) break
            read += bytesRead
          }
          if (read !== status.size) throw storageUnavailable()
          return bytes.subarray(0, read)
        } finally {
          await handle.close()
        }
      } catch {
        throw storageUnavailable()
      }
    },
  }
}
