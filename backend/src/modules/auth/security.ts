import { createHash, randomBytes } from 'node:crypto'
import { argon2id, hash, verify } from 'argon2'

export const SESSION_MS = 12 * 60 * 60 * 1000
export const INVITATION_MS = 7 * 24 * 60 * 60 * 1000
export const COOKIE_NAME = 'membership_session'
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/
export const newToken = () => randomBytes(32).toString('base64url')
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex')
export const hashPassword = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
export async function verifyPassword(encoded: string, password: string) {
  if (!encoded.startsWith('$argon2id$')) return false
  try {
    return await verify(encoded, password)
  } catch {
    return false
  }
}

export function sessionCookie(header: string | undefined) {
  const values = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE_NAME + '='))
    .map((part) => part.slice(COOKIE_NAME.length + 1))
  return values.length === 1 && tokenPattern.test(values[0])
    ? values[0]
    : undefined
}
