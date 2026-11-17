import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { createApp } from '../src/app.ts'

let server: Server
let baseUrl: string

before(async () => {
  server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

test('health returns stable JSON without a database', async () => {
  for (const path of ['/health', '/api/v1/health']) {
    const response = await fetch(baseUrl + path)
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type') ?? '',
      /^application\/json/,
    )
    assert.deepEqual(await response.json(), { status: 'ok' })
  }
})

test('business routes are not exposed by this scaffold', async () => {
  const response = await fetch(baseUrl + '/api/v1/admin/products')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    error: { code: 'NOT_FOUND', message: 'Route not found.' },
  })
})
