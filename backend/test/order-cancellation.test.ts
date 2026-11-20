import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelAdminOrder,
  cancelCustomerOrder,
} from '../src/modules/orders/cancel-schemas.ts'
import { startOrderTimeoutScheduler } from '../src/modules/orders/timeout.ts'

test('cancellation strict DTOs require versions, distinguish reason rules and reject forged fields', () => {
  for (const schema of [cancelAdminOrder, cancelCustomerOrder]) {
    for (const expectedVersion of [
      undefined,
      null,
      0,
      -1,
      1.1,
      '1',
      2147483648,
    ])
      assert(!schema.safeParse({ expectedVersion, reason: 'Cancel' }).success)
    for (const field of [
      'userId',
      'source',
      'actorType',
      'amountFen',
      'formData',
      'cancelledAt',
      'paymentStatus',
      'internalNote',
    ])
      assert(
        !schema.safeParse({
          expectedVersion: 1,
          reason: 'Cancel',
          [field]: 'forged',
        }).success,
      )
    for (const reason of [null, 42, 'a'.repeat(501)])
      assert(!schema.safeParse({ expectedVersion: 1, reason }).success)
  }
  for (const reason of [undefined, '', '   ']) {
    assert.equal(
      cancelCustomerOrder.parse({ expectedVersion: 1, reason }).reason,
      null,
    )
    assert(!cancelAdminOrder.safeParse({ expectedVersion: 1, reason }).success)
  }
  assert.equal(
    cancelAdminOrder.parse({ expectedVersion: 1, reason: ' Cancel ' }).reason,
    'Cancel',
  )
  assert.equal(
    cancelCustomerOrder.parse({ expectedVersion: 1, reason: ' Cancel ' })
      .reason,
    'Cancel',
  )
})

test('order timer starts immediately, runs each minute without overlap and waits on in-flight stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0,
    errors = 0,
    release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const stop = startOrderTimeoutScheduler(
    async () => {
      calls++
      await gate
      return { scanned: 100, cancelled: 99, failed: 1 }
    },
    () => {
      errors++
    },
  )
  assert.equal(calls, 1)
  t.mock.timers.tick(180000)
  assert.equal(calls, 1)
  let stopped = false
  const stopping = stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await stopping
  assert.equal(errors, 1)
  t.mock.timers.tick(120000)
  assert.equal(calls, 1)
})

test('order timer retries rejected sweeps on later ticks and never drains a failed batch in a loop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0,
    errors = 0
  const stop = startOrderTimeoutScheduler(
    async () => {
      calls++
      if (calls === 1) throw new Error('test')
      return { scanned: 100, cancelled: 0, failed: 100 }
    },
    () => {
      errors++
    },
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(errors, 1)
  t.mock.timers.tick(60000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(errors, 2)
  await stop()
})
