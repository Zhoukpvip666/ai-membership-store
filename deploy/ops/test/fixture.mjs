import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { createDatabase } from './src/db/client.ts'
import { hashPassword } from './src/modules/auth/security.ts'

const adminEmail = 'synthetic-admin@fixture.test'
const customerEmail = 'synthetic-customer@fixture.test'
const password = 'fixture-only-synthetic-password'
const privateMarker = 'T233_FIXTURE_PRIVATE_MARKER'
const cover = 'a0000000-0000-4000-8000-000000000000.webp'
const qr = 'b0000000-0000-4000-8000-000000000000.png'
const db = createDatabase(
  process.env.DATABASE_URL,
  process.env.MYSQL_AUTH_PUBLIC_KEY_FILE,
)

async function verifyRestoredWrites(base, admin, original) {
  async function request(path, method, body, status) {
    const response = await fetch(base + '/api/v1/admin/orders' + path, {
      method,
      headers: {
        Cookie: admin,
        Origin: process.env.APP_BASE_URL,
        'X-Requested-With': 'MembershipStore',
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, status)
    return (await response.json()).order
  }

  const created = await request(
    '',
    'POST',
    {
      productId: original.productId,
      userId: original.userId,
      amountFen: original.amountFen,
      formData: {},
    },
    201,
  )
  assert.equal(created.version, 1)
  const updated = await request(
    '/' + created.id + '/internal-note',
    'PATCH',
    {
      expectedVersion: created.version,
      internalNote: privateMarker,
    },
    200,
  )
  assert.equal(updated.version, 2)

  const revisions = () =>
    db.orderRevision.findMany({
      where: { orderId: created.id },
      orderBy: { version: 'asc' },
    })
  const snapshots = await revisions()
  assert.deepEqual(
    snapshots.map((row) => row.version),
    [1, 2],
  )
  assert.equal(snapshots[0].snapshotJson.order.internalNote, null)
  assert.equal(snapshots[1].snapshotJson.order.internalNote, privateMarker)
  await assert.rejects(
    db.$executeRaw`UPDATE \`Order\` SET source = 'USER', version = version + 1 WHERE id = ${created.id}`,
    /ORDER_SOURCE_IMMUTABLE/,
  )
  await assert.rejects(
    db.$executeRaw`UPDATE OrderRevision SET reason = 'forbidden' WHERE id = ${snapshots[0].id}`,
    /ORDER_REVISION_IMMUTABLE/,
  )
  assert.deepEqual(await revisions(), snapshots)
  const stillStored = await db.order.findUniqueOrThrow({
    where: { id: created.id },
  })
  assert.equal(stillStored.source, 'ADMIN')
  assert.equal(stillStored.version, 2)
  console.log(
    'Restored Order and OrderRevision triggers allowed versioned API writes and rejected illegal history mutations.',
  )
}

try {
  if (process.argv[2] === 'seed') {
    const now = new Date()
    const passwordHash = await hashPassword(password)
    const admin = await db.user.create({
      data: {
        loginEmail: adminEmail,
        username: 'fixture-admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        activatedAt: now,
        passwordHash,
      },
    })
    const customer = await db.user.create({
      data: {
        loginEmail: customerEmail,
        username: 'fixture-customer',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        activatedAt: now,
        passwordHash,
      },
    })
    const product = await db.product.create({
      data: {
        slug: 'synthetic',
        name: 'Synthetic fixture',
        type: 'SUBSCRIPTION',
        listed: true,
        priceFen: 100,
        renewalPriceFen: 100,
        termLabel: 'month',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        coverImageKey: cover,
      },
    })
    const order = await db.order.create({
      data: {
        contactEmailSnapshot: customerEmail,
        orderNo: '583024917',
        userId: customer.id,
        productId: product.id,
        source: 'ADMIN',
        createdByAdminId: admin.id,
        kind: 'INITIAL',
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        termSnapshot: 'month',
        servicePeriodUnitSnapshot: 'MONTH',
        servicePeriodCountSnapshot: 1,
        amountFen: 100,
        internalNote: privateMarker,
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
        paidAt: now,
        paymentConfirmedAt: now,
      },
    })
    await db.paymentTransaction.create({
      data: {
        orderId: order.id,
        kind: 'PAYMENT',
        channel: 'WECHAT',
        status: 'CONFIRMED',
        amountFen: 100,
        occurredAt: now,
        confirmedAt: now,
        createdByAdminId: admin.id,
        confirmedByAdminId: admin.id,
      },
    })
    await db.subscription.create({
      data: {
        userId: customer.id,
        productId: product.id,
        sourceType: 'ADMIN',
        createdByAdminId: admin.id,
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        priceSnapshotFen: 100,
        termSnapshot: 'month',
        renewalPriceFen: 100,
        startedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    })
    await db.adminAuditLog.create({
      data: {
        actorAdminId: admin.id,
        action: 'FIXTURE',
        entityType: 'Order',
        entityId: order.id,
      },
    })
    await db.idempotencyRecord.create({
      data: {
        actorUserId: customer.id,
        keyHash: '1'.repeat(64),
        requestHash: '2'.repeat(64),
        operation: 'fixture',
        responseJson: { synthetic: true },
      },
    })
    await db.appSettings.create({
      data: {
        storeName: 'Fixture store',
        ownerEmail: adminEmail,
        wechatPayEnabled: true,
        wechatQrImageKey: qr,
      },
    })
    const pixels = () =>
      sharp({
        create: { width: 4, height: 4, channels: 3, background: '#446688' },
      })
    await writeFile(
      process.env.PRODUCT_COVER_STORAGE_DIR + '/' + cover,
      await pixels().webp().toBuffer(),
    )
    await writeFile(
      process.env.WECHAT_QR_STORAGE_DIR + '/' + qr,
      await pixels().png().toBuffer(),
    )
    console.log('Synthetic database and both images created.')
  } else {
    const order = await db.order.findUniqueOrThrow({
      where: { orderNo: '583024917' },
    })
    const child = spawn(process.execPath, ['dist/server.js', '--production'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let observed = ''
    child.stdout.on('data', (data) => {
      observed += data
    })
    child.stderr.on('data', (data) => {
      observed += data
    })
    const closed = once(child, 'exit')
    const base = 'http://127.0.0.1:3101'
    async function login(email) {
      const response = await fetch(base + '/api/v1/auth/login', {
        method: 'POST',
        headers: {
          Origin: process.env.APP_BASE_URL,
          'X-Requested-With': 'MembershipStore',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })
      assert.equal(response.status, 200)
      return response.headers.getSetCookie()[0].split(';')[0]
    }
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          if ((await fetch(base + '/api/v1/health')).ok) break
        } catch {
          /* API is starting. */
        }
        await delay(125)
      }
      assert.equal((await fetch(base + '/api/v1/health')).status, 200)
      const admin = await login(adminEmail)
      const customer = await login(customerEmail)
      assert.equal(
        (await fetch(base + '/api/v1/catalog/products/synthetic')).status,
        200,
      )
      assert.equal(
        (
          await fetch(base + '/api/v1/customer/orders/' + order.id, {
            headers: { Cookie: customer },
          })
        ).status,
        200,
      )
      for (const [path, name, cookie, directory] of [
        [
          '/api/v1/catalog/products/synthetic/cover-image',
          cover,
          '',
          process.env.PRODUCT_COVER_STORAGE_DIR,
        ],
        [
          '/api/v1/admin/settings/wechat-qr',
          qr,
          admin,
          process.env.WECHAT_QR_STORAGE_DIR,
        ],
      ]) {
        const response = await fetch(base + path, {
          headers: { Cookie: cookie },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          await readFile(directory + '/' + name),
        )
      }
      await verifyRestoredWrites(base, admin, order)
      const metrics = await (await fetch(base + '/internal/ops/metrics')).json()
      assert.equal(metrics.workers.orderTimeout.lastResult, 'succeeded')
      assert.equal(metrics.workers.subscriptionExpiry.lastResult, 'succeeded')
      assert.ok(
        !observed.includes(adminEmail) &&
          !observed.includes(customerEmail) &&
          !observed.includes(password) &&
          !observed.includes(admin) &&
          !observed.includes(privateMarker),
      )
      assert.ok(
        observed
          .trim()
          .split('\n')
          .every((line) => JSON.parse(line).event),
      )
      console.log(
        'Restored API health, ADMIN/CUSTOMER login, catalog/order reads, image bytes and redacted metrics/logs passed.',
      )
    } finally {
      child.kill('SIGTERM')
      const [exit] = await closed
      assert.equal(exit, 0)
    }
  }
} catch (error) {
  if (error instanceof assert.AssertionError) {
    console.error(
      'Synthetic fixture assertion failed at',
      error.stack
        .split('\n')
        .find((line) => line.includes('fixture.mjs'))
        ?.trim(),
    )
  } else {
    console.error('Synthetic fixture failed', error.name, error.code ?? '')
  }
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
