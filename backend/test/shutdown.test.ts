import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGracefulShutdown } from '../src/shutdown.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('shutdown starts HTTP and both worker drains once and waits before Prisma disconnects', async () => {
  const order: string[] = []
  const http = deferred()
  const orderWorker = deferred()
  const subscriptionWorker = deferred()
  const shutdown = createGracefulShutdown(
    [
      () => {
        order.push('http')
        return http.promise
      },
      () => {
        order.push('orders')
        return orderWorker.promise
      },
      () => {
        order.push('subscriptions')
        return subscriptionWorker.promise
      },
    ],
    async () => {
      order.push('disconnect')
    },
  )
  const result = shutdown()
  assert.equal(shutdown(), result)
  await Promise.resolve()
  assert.deepEqual(order, ['http', 'orders', 'subscriptions'])
  http.resolve()
  orderWorker.resolve()
  await Promise.resolve()
  assert.ok(!order.includes('disconnect'))
  subscriptionWorker.resolve()
  await result
  assert.deepEqual(order, ['http', 'orders', 'subscriptions', 'disconnect'])
})

test('a failed drain does not disconnect Prisma while another operation is in flight', async () => {
  const work = deferred()
  let disconnected = false
  const shutdown = createGracefulShutdown(
    [
      async () => {
        throw Error('synthetic drain failure')
      },
      () => work.promise,
    ],
    async () => {
      disconnected = true
    },
  )
  const stopping = assert.rejects(shutdown(), /could not drain cleanly/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(disconnected, false)
  work.resolve()
  await stopping
  assert.equal(disconnected, true)
})
