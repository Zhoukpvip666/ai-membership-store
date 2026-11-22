import sharp from 'sharp'
import { ApiError } from '../http/errors.ts'

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

type ImageOptions = {
  maxBytes: number
  maxDimension: number
  output: 'png' | 'webp'
  invalid: () => ApiError
  tooLarge: () => ApiError
}

export async function encodeImage(input: unknown, options: ImageOptions) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw options.invalid()
  if (input.length > options.maxBytes) throw options.tooLarge()
  const format = imageType(input)
  if (!format) throw options.invalid()

  let encoded: Buffer
  try {
    const image = sharp(input, {
      limitInputPixels: options.maxDimension ** 2,
      failOn: 'warning',
    })
    const { format: decoded, width, height, pages } = await image.metadata()
    if (
      decoded !== format ||
      !width ||
      !height ||
      width > options.maxDimension ||
      height > options.maxDimension ||
      (pages ?? 1) !== 1
    )
      throw options.invalid()
    const oriented = image.autoOrient()
    encoded = await (
      options.output === 'png' ? oriented.png() : oriented.webp({ quality: 85 })
    ).toBuffer()
  } catch {
    throw options.invalid()
  }
  if (encoded.length > options.maxBytes) throw options.tooLarge()
  return encoded
}
