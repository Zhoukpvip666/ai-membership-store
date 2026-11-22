import { ApiError } from '../../http/errors.ts'
import { encodeImage } from '../../storage/image.ts'

export const maxQrBytes = 2 * 1024 * 1024

export function encodeWechatImage(input: unknown) {
  return encodeImage(input, {
    maxBytes: maxQrBytes,
    maxDimension: 2048,
    output: 'png',
    invalid: () =>
      new ApiError(
        400,
        'WECHAT_QR_INVALID',
        '请上传有效的 PNG、JPEG 或 WebP 图片，宽高均不得超过 2048 像素',
      ),
    tooLarge: () =>
      new ApiError(413, 'PAYLOAD_TOO_LARGE', '收款码图片不得超过 2 MB'),
  })
}
