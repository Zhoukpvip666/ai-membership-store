import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '../src/generated/prisma/client.ts'
import { insertWithOrderNumber } from '../src/modules/orders/order-number.ts'

test('order number allocation always passes nine digits with a nonzero first digit', async () => {
  for (let sample = 0; sample < 300; sample++) {
    const orderNo = await insertWithOrderNumber(async (value) => value)
    assert.match(orderNo, /^[1-9][0-9]{8}$/)
  }
})

test('other database errors are thrown unchanged without another insertion attempt', async () => {
  const databaseError = (code: string, index: string) =>
    new Prisma.PrismaClientKnownRequestError('Fixture database error', {
      clientVersion: 'test',
      code,
      meta: {
        driverAdapterError: {
          cause: { kind: 'UniqueConstraintViolation', constraint: { index } },
        },
      },
    })
  for (const failure of [
    databaseError('P2002', 'PRIMARY'),
    databaseError('P2002', 'IdempotencyRecord_actorUserId_keyHash_key'),
    databaseError('P2003', 'Order_orderNo_key'),
    new Prisma.PrismaClientKnownRequestError('Unspecified duplicate key', {
      clientVersion: 'test',
      code: 'P2002',
    }),
  ]) {
    let attempts = 0
    await assert.rejects(
      insertWithOrderNumber(async () => {
        attempts++
        throw failure
      }),
      (error) => error === failure,
    )
    assert.equal(attempts, 1)
  }
})
