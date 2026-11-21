import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { encodeWechatImage } from '../src/modules/settings/wechat-image.ts'

test('QR uploads decode actual pixels and strip embedded metadata', async () => {
  const source = await sharp({
    create: { width: 33, height: 45, channels: 3, background: '#123456' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  const original = await sharp(source).metadata()
  assert(original.exif)
  const png = await encodeWechatImage(source)
  const { format, width, height, exif } = await sharp(png).metadata()
  assert.deepEqual(
    { format, width, height, exif },
    {
      format: 'png',
      width: 45,
      height: 33,
      exif: undefined,
    },
  )
  await assert.rejects(
    encodeWechatImage(source.subarray(0, source.length - 30)),
    {
      code: 'WECHAT_QR_INVALID',
    },
  )
})
