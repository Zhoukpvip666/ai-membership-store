import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../generated/prisma/client.ts'

export function createDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const adapter = new PrismaMariaDb({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: 'Z',
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
