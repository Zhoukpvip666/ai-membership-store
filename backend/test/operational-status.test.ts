import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createApp } from '../src/app.ts'
import { operationalStatus } from '../src/http/operational-status.ts'
import { startOrderTimeoutScheduler } from '../src/modules/orders/timeout.ts'
import { startExpiryScheduler } from '../src/modules/subscriptions/scheduler.ts'

test('HTTP and worker telemetry is bounded and excludes input data and driver errors', async () => {
  const marker = 'TEST_PRIVATE_PAYLOAD_MARKER'
  const lines: string[] = []
  let time = 1_700_000_000_000
  const release = 'a'.repeat(40)
  const ops = operationalStatus(
    release,
    (line) => lines.push(line),
    () => time,
  )
  const app = createApp(
    async () => {
      throw new Error(marker)
    },
    undefined,
    ops,
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = 'http://127.0.0.1:' + address.port
  try {
    const stopOrder = startOrderTimeoutScheduler(
      async () => {
        throw new Error(marker)
      },
      () => {},
      ops.observe('orderTimeout'),
    )
    const stopExpiry = startExpiryScheduler(
      async () => 0,
      () => {},
      ops.observe('subscriptionExpiry'),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.all([stopOrder(), stopExpiry()])
    const unsafe = await fetch(
      base + '/api/v1/auth/' + marker + '?secret=' + marker,
      {
        method: 'POST',
        headers: {
          Cookie: marker,
          Authorization: marker,
          'Idempotency-Key': marker,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: marker, email: marker }),
      },
    )
    assert.equal(unsafe.status, 404)
    assert.equal((await fetch(base + '/health?' + marker)).status, 503)
    time += 120000
    const metrics = await (await fetch(base + '/internal/ops/metrics')).json()
    assert.equal(metrics.releaseSha, release)
    assert.equal(metrics.requests.count, 1)
    assert.equal(metrics.requests.latency.length, 12)
    assert.equal(metrics.workers.orderTimeout.consecutiveFailures, 1)
    assert.equal(metrics.workers.orderTimeout.lastResult, 'failed')
    assert.equal(
      metrics.workers.subscriptionExpiry.secondsSinceLastSuccess,
      120,
    )
    time += 300000
    assert.equal(
      (await (await fetch(base + '/internal/ops/metrics')).json()).requests
        .count,
      0,
    )
    assert.ok(!lines.join('').includes(marker))
    assert.ok(
      lines
        .map((line) => JSON.parse(line))
        .every((entry) => entry.releaseSha === release),
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
