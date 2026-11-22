import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { storagePath } from '../storage/immutable-images.ts'

export const defaultQrStorage = fileURLToPath(
  new URL('../../../.local-data/wechat-qr/', import.meta.url),
)
export const defaultCoverStorage = fileURLToPath(
  new URL('../../../.local-data/product-covers/', import.meta.url),
)

// Mirror the directories the Vite dev server is allowed to serve.
const webDirectories = [
  'frontend/',
  'node_modules/',
  'backend/src/contracts/',
].map((path) => fileURLToPath(new URL('../../../' + path, import.meta.url)))

function contains(directory: string, candidate: string) {
  const path = relative(storagePath(directory), storagePath(candidate))
  return !isAbsolute(path) && path.split(/[\\/]/)[0] !== '..'
}

export function isPrivateCoverDirectory(qr: string, cover: string) {
  let qrRoot = qr
  try {
    qrRoot = realpathSync.native(qr)
  } catch {
    // The optional QR directory may not exist until its first upload.
  }
  return ![qr, qrRoot, ...webDirectories].some(
    (root) => contains(root, cover) || contains(cover, root),
  )
}
