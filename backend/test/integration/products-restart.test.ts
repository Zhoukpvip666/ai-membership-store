import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
async function verifyApiRestart() {
  const env = integrationEnvironment()
  let cookie = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    )
    const origin = 'http://127.0.0.1:' + address.port
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../src/server.ts', import.meta.url))],
      {
        env: { ...process.env, ...env, API_PORT: String(address.port) },
        stdio: 'ignore',
      },
    )
    let failed = false
    child.on('error', () => {
      failed = true
    })
    try {
      let ready = false
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !failed && child.exitCode === null) {
        try {
          ready = (
            await fetch(origin + '/api/v1/health', {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        } catch {
          /* Startup has not completed. */
        }
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert(ready, 'Isolated API child must become healthy')
      if (attempt === 0) {
        const response = await fetch(origin + '/api/v1/auth/login', {
          method: 'POST',
          headers: {
            origin: env.APP_BASE_URL,
            'content-type': 'application/json',
            'x-requested-with': 'MembershipStore',
          },
          body: JSON.stringify({
            email: env.ADMIN_EMAIL,
            password: env.ADMIN_PASSWORD,
          }),
        })
        assert.equal(response.status, 200)
        cookie = response.headers.get('set-cookie')!.split(';')[0]!
      }
      const response = await fetch(
        origin + '/api/v1/admin/products?search=Restart',
        { headers: { cookie } },
      )
      assert.equal(response.status, 200)
      const list = await response.json()
      assert.equal(list.items[0].slug, 'restart-persistence')
      assert.deepEqual(list.items[0].formSchema, { version: 1, fields: [] })
      const settings = await fetch(origin + '/api/v1/admin/settings', {
        headers: { cookie },
      })
      assert.equal(settings.status, 200)
      assert.equal(
        (await settings.json()).settings.storeName,
        'Persisted settings',
      )
    } finally {
      if (child.exitCode === null && !failed) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
  }
}
test('real MySQL restart retains product JSON, archive state, settings and all eleven business tables', async () => {
  const db = createDatabase(integrationEnvironment().DATABASE_URL)
  try {
    const p = await db.product.findUniqueOrThrow({
      where: { slug: 'restart-persistence' },
    })
    assert.deepEqual(p.formSchema, { version: 1, fields: [] })
    const archived = await db.product.findFirstOrThrow({
      where: { name: 'Changed current name' },
    })
    assert(archived.archivedAt)
    assert.equal(archived.priceFen, 5678)
    assert.equal(
      (archived.formSchema as { fields: { id: string }[] }).fields[0]!.id,
      'date_id',
    )
    assert.equal(
      (await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).storeName,
      'Persisted settings',
    )
    const tables = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME <> '_prisma_migrations'`
    assert.equal(Number(tables[0]!.count), 11)
    await verifyApiRestart()
  } finally {
    await db.$disconnect()
  }
})
