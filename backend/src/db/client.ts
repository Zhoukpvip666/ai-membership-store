import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { EnvironmentError } from '../config/env.ts'
import { PrismaClient } from '../generated/prisma/client.ts'

function mysqlAuthKey(file: string | undefined) {
  if (!file) return undefined
  try {
    const pem = readFileSync(file, 'utf8').trim()
    if (
      pem.startsWith('-----BEGIN PUBLIC KEY-----') &&
      createPublicKey(pem).asymmetricKeyType === 'rsa'
    )
      return pem
  } catch {
    // The file path and content may be supplied by a private deployment context.
  }
  throw new EnvironmentError(['MYSQL_AUTH_PUBLIC_KEY_FILE'])
}

export function createDatabase(databaseUrl: string, publicKeyFile?: string) {
  const url = new URL(databaseUrl)
  const adapter = new PrismaMariaDb({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: 'Z',
    cachingRsaPublicKey: mysqlAuthKey(publicKeyFile),
    connectionLimit: 5,
    connectTimeout: 2000,
    acquireTimeout: 3000,
    socketTimeout: 3000,
  })
  return new PrismaClient({ adapter, log: [] })
}

export async function checkDatabase(database: PrismaClient) {
  await database.$queryRaw`SELECT 1`
}
