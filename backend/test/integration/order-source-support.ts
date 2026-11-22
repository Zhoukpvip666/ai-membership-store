// Database assertions only; callers must use integrationEnvironment's isolated DB.
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import type { Prisma } from '../../src/generated/prisma/client.ts'

type Reader = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>
export async function businessSnapshot(db: Reader) {
  const result: Record<string, Record<string, unknown>[]> = {}
  for (const table of [
    'User',
    'Product',
    'Order',
    'PaymentTransaction',
    'OrderEvent',
    'Subscription',
    'SubscriptionEvent',
    'AdminAuditLog',
    'Session',
    'InvitationToken',
    'AppSettings',
    'IdempotencyRecord',
  ]) {
    // Identifiers come only from this fixed whitelist. Never print row contents.
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM \`${table}\` ORDER BY id`,
    )
    result[table] =
      table === 'AppSettings'
        ? rows.map((row) => ({
            // Older migration fixtures have no WeChat columns yet.
            wechatQrImageKey: null,
            ...row,
            wechatPayEnabled: Number(row.wechatPayEnabled ?? 0),
          }))
        : table === 'Product'
          ? rows.map((row) => ({ coverImageKey: null, ...row }))
          : rows
  }
  return result
}

export async function rejectedWithoutChanges(
  db: Reader,
  operation: () => PromiseLike<unknown>,
  expected: RegExp,
) {
  const before = await businessSnapshot(db)
  await assert.rejects(Promise.resolve().then(operation), (error: unknown) =>
    expected.test(String(error)),
  )
  assert(
    isDeepStrictEqual(await businessSnapshot(db), before),
    'Rejected SQL changed an order or related business records.',
  )
}
