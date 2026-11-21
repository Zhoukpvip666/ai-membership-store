import sharp from 'sharp'
import { ApiError } from '../../http/errors.ts'

export const maxQrBytes = 2 * 1024 * 1024
const maxDimension = 2048
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function imageType(input: Buffer) {
  if (input.subarray(0, 8).equals(pngSignature)) return 'png'
  if (input[0] === 255 && input[1] === 216 && input[2] === 255) return 'jpeg'
  if (
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp'
}

export async function encodeWechatImage(input: unknown) {
  const invalid = () =>
    new ApiError(
      400,
      'WECHAT_QR_INVALID',
      '请上传有效的 PNG、JPEG 或 WebP 图片，宽高均不得超过 2048 像素',
    )
  const tooLarge = () =>
    new ApiError(413, 'PAYLOAD_TOO_LARGE', '收款码图片不得超过 2 MB')
  if (!Buffer.isBuffer(input) || input.length === 0) throw invalid()
  if (input.length > maxQrBytes) throw tooLarge()
  const format = imageType(input)
  if (!format) throw invalid()

  let encoded: Buffer
  try {
    const image = sharp(input, {
      limitInputPixels: maxDimension ** 2,
      failOn: 'warning',
    })
    const { format: decoded, width, height, pages } = await image.metadata()
    if (
      decoded !== format ||
      !width ||
      !height ||
      width > maxDimension ||
      height > maxDimension ||
      (pages ?? 1) !== 1
    )
      throw invalid()
    encoded = await image.autoOrient().png().toBuffer()
  } catch {
    throw invalid()
  }
  if (encoded.length > maxQrBytes) throw tooLarge()
  return encoded
}
