import { ApiError } from '../../http/errors.ts'
import { immutableImageStorage } from '../../storage/immutable-images.ts'
import { defaultQrStorage } from '../../config/image-directories.ts'
import { maxQrBytes } from './wechat-image.ts'

export function wechatImageStorage(directory = defaultQrStorage) {
  return immutableImageStorage(
    directory,
    '.png',
    maxQrBytes,
    () =>
      new ApiError(
        503,
        'WECHAT_QR_STORAGE_UNAVAILABLE',
        '收款码存储暂不可用，请检查存储配置',
      ),
    true,
  )
}
