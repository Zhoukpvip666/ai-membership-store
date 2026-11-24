import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { rename, writeFile, unlink } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { maxQrBytes } from '../../src/modules/settings/wechat-image.ts'
import { wechatPaymentService } from '../../src/modules/settings/wechat-payment.ts'
import { activeCredentials, integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const directory = env.WECHAT_QR_STORAGE_DIR
assert(directory, 'Payment tests need the runner-owned storage directory')
let db = createDatabase(env.DATABASE_URL)
let server: Server
let origin: string
let adminId: string
let adminCookie: string
let customerCookie: string
const settings = '/admin/settings/wechat-payment'
const image = '/admin/settings/wechat-qr'
const imageUrl = '/api/v1' + image

async function start() {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  origin = 'http://127.0.0.1:' + address.port + '/api/v1'
}

async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await db.$disconnect()
}

async function session(userId: string) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  return COOKIE_NAME + '=' + token
}

function request(
  path: string,
  method = 'GET',
  input?: Buffer | object,
  cookie = adminCookie,
  headers?: Record<string, string>,
) {
  const binary = Buffer.isBuffer(input)
  return fetch(origin + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: env.APP_BASE_URL,
      'X-Requested-With': 'MembershipStore',
      ...(input
        ? {
            'Content-Type': binary
              ? 'application/octet-stream'
              : 'application/json',
          }
        : {}),
      ...headers,
    },
    body: binary
      ? new Uint8Array(input)
      : input
        ? JSON.stringify(input)
        : undefined,
  })
}

const picture = (background = '#FFFFFF', width = 64) =>
  sharp({ create: { width, height: 64, channels: 3, background } })
const current = () => db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
const actionCount = () =>
  db.adminAuditLog.count({ where: { action: { startsWith: 'WECHAT_' } } })

before(async () => {
  adminId = (await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id
  const customer = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      status: 'ACTIVE',
      ...(await activeCredentials()),
      role: 'CUSTOMER',
    },
  })
  adminCookie = await session(adminId)
  customerCookie = await session(customer.id)
  await start()
})
after(stop)

test('only ADMIN can read or mutate settings, with the existing CSRF policy and a scoped binary exception', async () => {
  const bytes = await picture().png().toBuffer()
  for (const [path, method, payload] of [
    [settings, 'GET'],
    [image, 'GET'],
    [image, 'PUT', bytes],
    [settings, 'PATCH', { enabled: true }],
  ] as const) {
    assert.equal((await request(path, method, payload, '')).status, 401)
    assert.equal(
      (await request(path, method, payload, customerCookie)).status,
      403,
    )
  }
  const invalidHeaders: Record<string, string>[] = [
    { Origin: 'http://untrusted.example' },
    { 'X-Requested-With': '' },
  ]
  for (const headers of invalidHeaders)
    assert.equal(
      (await request(image, 'PUT', bytes, adminCookie, headers)).status,
      403,
    )
  assert.equal(
    (await request(image, 'PUT', { path: 'secret.png' })).status,
    403,
  )
  assert.equal((await request('/admin/settings', 'PATCH', bytes)).status, 403)
  assert.equal((await request(image + '?path=../../other', 'GET')).status, 400)
  assert.equal(
    (await request(image + '?path=../../other', 'PUT', bytes)).status,
    400,
  )
  assert.equal(
    (
      await request(
        '/customer/settings/wechat-qr',
        'GET',
        undefined,
        customerCookie,
      )
    ).status,
    404,
  )
  assert.equal(await actionCount(), 0)
})

test('starts disabled and refuses enable without an existing image in both the API and database', async () => {
  assert.deepEqual(await (await request(settings)).json(), {
    enabled: false,
    imageUrl: null,
  })
  assert.equal((await request(image)).status, 404)
  assert.equal(
    (await request(settings, 'PATCH', { enabled: true })).status,
    409,
  )
  assert.equal(
    (await request(settings, 'PATCH', { enabled: false, path: '/fake' }))
      .status,
    400,
  )
  await assert.rejects(
    db.appSettings.update({
      where: { id: 1 },
      data: { wechatPayEnabled: true },
    }),
  )
  assert.equal(await actionCount(), 0)
})

test('rejects oversized, unsupported, spoofed and corrupt bytes without publishing a reference', async () => {
  const png = await picture().png().toBuffer()
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('https://example.com/qr.png'),
    png.subarray(0, 40),
    await picture('#FFFFFF', 2049).png().toBuffer(),
    await picture().gif().toBuffer(),
  ]) {
    const response = await request(image, 'PUT', bytes)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'WECHAT_QR_INVALID')
  }
  assert.equal(
    (await request(image, 'PUT', Buffer.alloc(maxQrBytes + 1))).status,
    413,
  )
  assert.equal((await current()).wechatQrImageKey, null)
  assert.equal(await actionCount(), 0)
})

test('decodes PNG, JPEG and WebP, serves canonical bytes, preserves the toggle on replacement, and survives a server restart', async () => {
  let previousKey: string | null = null
  for (const [index, file] of [
    await picture().png().toBuffer(),
    await picture('#00FFFF').jpeg().toBuffer(),
    await picture('#0000FF').webp().toBuffer(),
  ].entries()) {
    const response = await request(image, 'PUT', file)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { enabled: index > 0, imageUrl })
    const saved = await current()
    assert.match(saved.wechatQrImageKey ?? '', /^[a-f0-9-]{36}\.png$/)
    assert.notEqual(saved.wechatQrImageKey, previousKey)
    previousKey = saved.wechatQrImageKey
    const preview = await request(image)
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-type'), 'image/png')
    assert.equal(preview.headers.get('cache-control'), 'no-store')
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
    const metadata = await sharp(
      Buffer.from(await preview.arrayBuffer()),
    ).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 64)
    if (index === 0)
      assert.equal(
        (await request(settings, 'PATCH', { enabled: true })).status,
        200,
      )
  }
  const pixels = Buffer.from(await (await request(image)).arrayBuffer())
  await stop()
  db = createDatabase(env.DATABASE_URL)
  await start()
  assert.deepEqual(await (await request(settings)).json(), {
    enabled: true,
    imageUrl,
  })
  assert.deepEqual(
    Buffer.from(await (await request(image)).arrayBuffer()),
    pixels,
  )
  assert.deepEqual(
    await (await request(settings, 'PATCH', { enabled: false })).json(),
    {
      enabled: false,
      imageUrl,
    },
  )
  assert.equal((await request(image)).status, 200)

  const audits = await db.adminAuditLog.findMany({
    where: { action: { startsWith: 'WECHAT_' } },
  })
  assert.equal(audits.length, 5)
  assert.deepEqual(audits.map((row) => row.action).sort(), [
    'WECHAT_PAYMENT_DISABLED',
    'WECHAT_PAYMENT_ENABLED',
    'WECHAT_QR_REPLACED',
    'WECHAT_QR_REPLACED',
    'WECHAT_QR_UPLOADED',
  ])
  for (const row of audits) {
    assert.equal(row.actorAdminId, adminId)
    for (const state of [row.beforeJson, row.afterJson])
      assert.deepEqual(Object.keys(state as object).sort(), [
        'enabled',
        'hasImage',
      ])
  }
  const adminSettings = (await (await request('/admin/settings')).json())
    .settings
  assert.equal(Object.hasOwn(adminSettings, 'wechatQrImageKey'), false)
  const guidance = await (
    await request('/customer/order-guidance', 'GET', undefined, customerCookie)
  ).json()
  assert.deepEqual(Object.keys(guidance).sort(), [
    'businessTimezone',
    'paymentInstructions',
    'storeName',
  ])
})

test('file failures and real audit rollback preserve the previous image reference and bytes', async () => {
  const saved = await current()
  const pixels = Buffer.from(await (await request(image)).arrayBuffer())
  const replacement = await picture('#FF0000').png().toBuffer()
  const actor = { actorAdminId: adminId, requestId: randomUUID() }
  const blockedDirectory = join(directory, 'blocked')
  await writeFile(blockedDirectory, 'file, not directory')
  try {
    await assert.rejects(
      wechatPaymentService(db, blockedDirectory).upload(replacement, actor),
      {
        code: 'WECHAT_QR_STORAGE_UNAVAILABLE',
      },
    )
  } finally {
    await unlink(blockedDirectory)
  }
  await assert.rejects(
    wechatPaymentService(db, directory).upload(replacement, {
      ...actor,
      actorAdminId: randomUUID(),
    }),
  )
  assert.deepEqual(await current(), saved)
  assert.deepEqual(
    Buffer.from(await (await request(image)).arrayBuffer()),
    pixels,
  )
  assert.equal(await actionCount(), 5)
})

test('a missing file cannot be enabled and a corrupt stored reference cannot access other files', async () => {
  const saved = await current()
  assert(saved.wechatQrImageKey)
  const file = join(directory, saved.wechatQrImageKey)
  await rename(file, file + '.test-hidden')
  try {
    assert.equal((await request(image)).status, 503)
    assert.equal(
      (await request(settings, 'PATCH', { enabled: true })).status,
      503,
    )
  } finally {
    await rename(file + '.test-hidden', file)
  }
  try {
    await db.appSettings.update({
      where: { id: 1 },
      data: { wechatQrImageKey: '../test.env' },
    })
    const response = await request(image)
    assert.equal(response.status, 503)
    assert.equal(
      (await response.json()).error.code,
      'WECHAT_QR_STORAGE_UNAVAILABLE',
    )
  } finally {
    await db.appSettings.update({
      where: { id: 1 },
      data: { wechatQrImageKey: saved.wechatQrImageKey },
    })
  }
  assert.equal(await actionCount(), 5)
})
