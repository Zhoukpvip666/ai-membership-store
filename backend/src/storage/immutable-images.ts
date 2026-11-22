import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ApiError } from '../http/errors.ts'

const imageKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:png|webp)$/

export const storagePath = (path: string) => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
const sameFile = (a: { dev: number; ino: number }, b: typeof a) =>
  a.dev === b.dev && a.ino === b.ino

// Check the canonical parent before creating a missing directory.
async function checkedDirectory(
  directory: string,
  create: boolean,
): Promise<Stats> {
  try {
    const status = await lstat(directory)
    if (
      !status.isDirectory() ||
      storagePath(await realpath(directory)) !== storagePath(directory)
    )
      throw new Error('Storage directory has an alias')
    return status
  } catch (error) {
    const parent = dirname(directory)
    if (
      !create ||
      parent === directory ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw error
    await checkedDirectory(parent, true)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (race) {
      if ((race as NodeJS.ErrnoException).code !== 'EEXIST') throw race
    }
    return checkedDirectory(directory, false)
  }
}

export function immutableImageStorage(
  directory: string,
  extension: '.png' | '.webp',
  maxBytes: number,
  unavailable: () => ApiError,
  allowDirectoryAlias = false,
) {
  const root = resolve(directory)
  async function openDirectory(create: boolean) {
    if (!allowDirectoryAlias) return checkedDirectory(root, create)
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  }
  async function assertDirectory(status?: Stats) {
    if (status && !sameFile(status, await checkedDirectory(root, false)))
      throw unavailable()
  }

  return {
    async write(bytes: Buffer) {
      try {
        const directoryStatus = await openDirectory(true)
        const key = randomUUID() + extension
        const file = await open(join(root, key), 'wx', 0o600)
        try {
          await assertDirectory(directoryStatus)
          await file.writeFile(bytes)
          await file.sync()
          await assertDirectory(directoryStatus)
        } finally {
          await file.close()
        }
        return key
      } catch {
        throw unavailable()
      }
    },
    async read(key: string) {
      if (!imageKey.test(key) || !key.endsWith(extension)) throw unavailable()
      try {
        const directoryStatus = await openDirectory(false)
        const file = join(directoryStatus ? root : await realpath(root), key)
        const status = await lstat(file)
        if (
          !status.isFile() ||
          (directoryStatus && status.nlink !== 1) ||
          status.size < 1 ||
          status.size > maxBytes
        )
          throw unavailable()
        const handle = await open(
          file,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        )
        try {
          const opened = await handle.stat()
          if (!sameFile(opened, status)) throw unavailable()
          await assertDirectory(directoryStatus)
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
          if (read !== status.size) throw unavailable()
          await assertDirectory(directoryStatus)
          return bytes.subarray(0, read)
        } finally {
          await handle.close()
        }
      } catch {
        throw unavailable()
      }
    },
  }
}
