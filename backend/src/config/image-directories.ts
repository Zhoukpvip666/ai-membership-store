import { fileURLToPath } from 'node:url'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { storagePath } from '../storage/immutable-images.ts'

export const defaultQrStorage = fileURLToPath(
  new URL('../../../.local-data/wechat-qr/', import.meta.url),
)
export const defaultCoverStorage = fileURLToPath(
  new URL('../../../.local-data/product-covers/', import.meta.url),
)

// Source and compiled configuration are both three levels below the release.
// The production static web root (frontend/dist) is inside this directory.
const releaseDirectory = fileURLToPath(new URL('../../../', import.meta.url))

// Mirror the directories the Vite dev server is allowed to serve.
const webDirectories = [
  'frontend/',
  'node_modules/',
  'backend/src/contracts/',
].map((path) => fileURLToPath(new URL('../../../' + path, import.meta.url)))

function contains(directory: string, candidate: string) {
  const path = relative(storagePath(directory), storagePath(candidate))
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

export function isPrivateProductionImageDirectory(directory: string) {
  const { root } = parse(directory)
  if (resolve(root) !== root) return false
  try {
    const release = realpathSync.native(releaseDirectory)
    if (
      [releaseDirectory, release].some(
        (root) => contains(root, directory) || contains(directory, root),
      )
    )
      return false

    // The directory may be provisioned later. Check the nearest existing parent
    // to catch aliases into the release even when a child does not exist yet.
    let existing = resolve(directory)
    for (;;) {
      const status = lstatSync(existing, { throwIfNoEntry: false })
      if (status)
        return (
          status.isDirectory() &&
          storagePath(realpathSync.native(existing)) === storagePath(existing)
        )
      const parent = dirname(existing)
      if (parent === existing) return false
      existing = parent
    }
  } catch {
    return false
  }
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
