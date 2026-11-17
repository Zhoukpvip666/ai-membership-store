import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const ready = process.env.EXPECT_DB_READY === '1'

test(
  ready
    ? 'real MySQL restart restores readiness and persisted seed'
    : 'stopped MySQL produces sanitized HTTP 503',
  async () => {
    const db = createDatabase(env.DATABASE_URL)
    const server = createApp(() => checkDatabase(db)).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      for (const path of ['/health', '/api/v1/health']) {
        const response: Response = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
        )
        assert.equal(response.status, ready ? 200 : 503)
        assert.deepEqual(
          await response.json(),
          ready
            ? { status: 'ok', database: 'ready' }
            : { status: 'degraded', database: 'unavailable' },
        )
      }
      if (ready) {
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1)
        assert.equal(await db.appSettings.count(), 1)
        assert.equal(await db.adminAuditLog.count(), 1)
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await db.$disconnect()
    }
  },
)
