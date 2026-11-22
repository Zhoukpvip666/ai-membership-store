import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  link,
  mkdir,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import {
  newToken,
  tokenHash,
  COOKIE_NAME,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const storage = env.PRODUCT_COVER_STORAGE_DIR
assert(storage, 'Requires the isolated test storage directory')
const root = storage
const maxBytes = 4 * 1024 * 1024
let app: Server
let base: string
let admin: string
let customer: string

async function loginSession(userId: string) {
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

before(async () => {
  admin = await loginSession(
    (await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id,
  )
  customer = await loginSession(
    (
      await db.user.create({
        data: {
          loginEmail: randomUUID() + '@covers.test',
          role: 'CUSTOMER',
          status: 'ACTIVE',
        },
      })
    ).id,
  )
  app = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(app, 'listening')
  const address = app.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
})
after(async () => {
  if (app) await new Promise<void>((resolve) => app.close(() => resolve()))
  await db.$disconnect()
})

function product(listed = true) {
  return db.product.create({
    data: {
      slug: 'cover-test-' + randomUUID(),
      name: 'Cover fixture',
      description: 'Public description only',
      type: 'ONE_TIME',
      priceFen: 19900,
      listed,
      termLabel: '一次性',
    },
  })
}

const adminProduct = (id: string) => '/api/v1/admin/products/' + id
const catalogProduct = (slug: string) => '/api/v1/catalog/products/' + slug
const imagePath = (path: string) => path + '/cover-image'

function request(
  path: string,
  method = 'GET',
  body?: Buffer | object,
  cookie = '',
  overrides: Record<string, string | undefined> = {},
) {
  const binary = Buffer.isBuffer(body)
  const headers = new Headers({
    Cookie: cookie,
    Origin: env.APP_BASE_URL,
    'X-Requested-With': 'MembershipStore',
    'Content-Type': binary ? 'application/octet-stream' : 'application/json',
    'Idempotency-Key': randomUUID(),
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) headers.delete(key)
    else headers.set(key, value)
  }
  return fetch(base + path, {
    method,
    headers,
    body: binary
      ? Uint8Array.from(body)
      : body
        ? JSON.stringify(body)
        : undefined,
  })
}

const upload = (
  id: string,
  image: Buffer,
  cookie = admin,
  headers?: Record<string, string | undefined>,
) => request(imagePath(adminProduct(id)), 'PUT', image, cookie, headers)
const remove = (id: string, cookie = admin) =>
  request(imagePath(adminProduct(id)), 'DELETE', {}, cookie)
const image = (
  format: 'png' | 'jpeg' | 'webp',
  width = 80,
  height = 60,
  background = '#325abc',
) =>
  sharp({ create: { width, height, channels: 3, background } })
    .toFormat(format)
    .toBuffer()
const bytes = async (response: Response) =>
  Buffer.from(await response.arrayBuffer())

async function error(response: Response, status: number, code?: string) {
  assert.equal(response.status, status)
  const result = await response.json()
  if (code) assert.equal(result.error.code, code)
  return result.error
}

function sql(statement: string) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      process.env.FOUNDATION_DB_TEST + '-mysql-1',
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --database=foundation_test',
    ],
    { input: statement, stdio: 'pipe', timeout: 10000 },
  )
}

test('all three source formats become clean WebP and only the product cover URL is public', async () => {
  const sample = await product()
  const original = await request(catalogProduct(sample.slug))
  assert.equal((await original.json()).coverImageUrl, null)
  await error(
    await request(imagePath(catalogProduct(sample.slug))),
    404,
    'NOT_FOUND',
  )
  let previous = ''
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const output = await upload(sample.id, await image(format))
    assert.equal(output.status, 200)
    const { coverImageUrl, updatedAt } = await output.json()
    assert.match(
      coverImageUrl,
      new RegExp(
        '^' + imagePath(adminProduct(sample.id)) + '\\?v=[0-9a-f]{16}$',
      ),
    )
    assert(Date.parse(updatedAt) > sample.updatedAt.getTime())
    assert.notEqual(coverImageUrl, previous)
    previous = coverImageUrl
    const adminDto = (
      await (
        await request(adminProduct(sample.id), 'GET', undefined, admin)
      ).json()
    ).product
    const { items } = await (
      await request(
        '/api/v1/admin/products?search=Cover',
        'GET',
        undefined,
        admin,
      )
    ).json()
    assert.equal(adminDto.coverImageUrl, coverImageUrl)
    assert.equal(
      items.find((item: { id: string }) => item.id === sample.id).coverImageUrl,
      coverImageUrl,
    )
    assert.equal(Object.hasOwn(adminDto, 'coverImageKey'), false)
    const publicDto = await (await request(catalogProduct(sample.slug))).json()
    assert.equal(Object.hasOwn(publicDto, 'coverImageKey'), false)
    assert.equal(Object.hasOwn(publicDto, 'formSchema'), false)
    assert.match(
      publicDto.coverImageUrl,
      new RegExp(
        '^' + imagePath(catalogProduct(sample.slug)) + '\\?v=[0-9a-f]{16}$',
      ),
    )
    const purchase = await (
      await request(
        '/api/v1/customer/products/' + sample.slug,
        'GET',
        undefined,
        customer,
      )
    ).json()
    assert.equal(purchase.coverImageUrl, publicDto.coverImageUrl)
    assert.equal(purchase.updatedAt, updatedAt)
    assert.equal(Object.hasOwn(purchase, 'coverImageKey'), false)
    const binary = await request(publicDto.coverImageUrl)
    assert.equal(binary.status, 200)
    assert.equal(binary.headers.get('content-type'), 'image/webp')
    assert.match(binary.headers.get('cache-control')!, /private, no-store/)
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff')
    const meta = await sharp(await bytes(binary)).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, 80)
    assert.equal(meta.height, 60)
    assert.equal(meta.exif, undefined)
  }
  const history = await db.adminAuditLog.findMany({
    where: { entityId: sample.id, action: { startsWith: 'PRODUCT_COVER_' } },
  })
  assert.equal(
    history.filter((row) => row.action === 'PRODUCT_COVER_UPLOADED').length,
    1,
  )
  assert.equal(
    history.filter((row) => row.action === 'PRODUCT_COVER_REPLACED').length,
    2,
  )
  assert(
    history.every(
      (row) =>
        JSON.stringify(row.afterJson) === JSON.stringify({ hasImage: true }),
    ),
  )
})

test('rejects empty, spoofed, truncated, oversized, over-dimension and excessive-pixel uploads', async () => {
  const sample = await product()
  const png = await image('png')
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.from('https://example.test/file.png'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('GIF89a'),
    png.subarray(0, 24),
    await image('png', 4097, 2),
    await image('png', 4097, 4097),
  ]) {
    await error(await upload(sample.id, invalid), 400, 'PRODUCT_COVER_INVALID')
  }
  await error(
    await upload(sample.id, Buffer.alloc(maxBytes + 1)),
    413,
    'PAYLOAD_TOO_LARGE',
  )
  assert.equal(
    (await db.product.findUniqueOrThrow({ where: { id: sample.id } }))
      .coverImageKey,
    null,
  )
})

test('applies admin sessions and exact CSRF rules to writes', async () => {
  const row = await product()
  const png = await image('png')
  await error(await upload(row.id, png, ''), 401, 'UNAUTHENTICATED')
  await error(await upload(row.id, png, customer), 403, 'FORBIDDEN')
  await error(await remove(row.id, ''), 401, 'UNAUTHENTICATED')
  await error(await remove(row.id, customer), 403, 'FORBIDDEN')
  await error(
    await request(imagePath(adminProduct(row.id)), 'GET', undefined, customer),
    403,
    'FORBIDDEN',
  )
  for (const override of [
    { Origin: undefined },
    { Origin: 'http://unexpected.test' },
    { 'X-Requested-With': undefined },
    { 'Content-Type': 'image/png' },
  ])
    await error(
      await upload(row.id, png, admin, override),
      403,
      'CSRF_REJECTED',
    )
  await error(
    await upload(row.id, png, admin, { 'Content-Encoding': 'gzip' }),
    415,
    'UNSUPPORTED_ENCODING',
  )
  await error(
    await request(adminProduct(row.id), 'PATCH', png, admin),
    403,
    'CSRF_REJECTED',
  )
  await error(await upload(randomUUID(), png), 404, 'NOT_FOUND')
})

test('keeps unpublished or archived covers private and provides the same public 404', async () => {
  const row = await product(false)
  assert.equal((await upload(row.id, await image('png'))).status, 200)
  assert.equal(
    (await request(imagePath(adminProduct(row.id)), 'GET', undefined, admin))
      .status,
    200,
  )
  const nonexistent = await error(
    await request(imagePath(catalogProduct('missing-product'))),
    404,
    'NOT_FOUND',
  )
  const unlisted = await error(
    await request(imagePath(catalogProduct(row.slug))),
    404,
    'NOT_FOUND',
  )
  assert.equal(unlisted.message, nonexistent.message)
  assert.equal(
    (await request(adminProduct(row.id), 'PATCH', { listed: true }, admin))
      .status,
    200,
  )
  const served = await request(imagePath(catalogProduct(row.slug)))
  assert.equal(served.status, 200)
  const etag = served.headers.get('etag')!
  assert.equal(
    (await request(adminProduct(row.id) + '/archive', 'POST', {}, admin))
      .status,
    200,
  )
  const archived = await error(
    await request(imagePath(catalogProduct(row.slug)), 'GET', undefined, '', {
      'If-None-Match': etag,
    }),
    404,
    'NOT_FOUND',
  )
  assert.equal(archived.message, nonexistent.message)
  await error(await upload(row.id, await image('png')), 409, 'PRODUCT_ARCHIVED')
  await error(await remove(row.id), 409, 'PRODUCT_ARCHIVED')
  assert.equal(
    (await request(imagePath(adminProduct(row.id)), 'GET', undefined, admin))
      .status,
    200,
  )
})

test('applies EXIF orientation and reads the latest replacement even through an older URL', async () => {
  const row = await product()
  const former = await upload(row.id, await image('png', 20, 40))
  const olderUrl = (await former.json()).coverImageUrl
  const jpeg = await sharp(await image('jpeg', 90, 40))
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  const replacement = await upload(row.id, jpeg)
  assert.equal(replacement.status, 200)
  assert.notEqual((await replacement.json()).coverImageUrl, olderUrl)
  const meta = await sharp(
    await bytes(await request(olderUrl, 'GET', undefined, admin)),
  ).metadata()
  assert.equal(meta.width, 40)
  assert.equal(meta.height, 90)
  assert.equal(meta.orientation, undefined)
  assert.equal(meta.exif, undefined)
  assert.equal((await (await remove(row.id)).json()).coverImageUrl, null)
  assert.equal(
    (await (await request(catalogProduct(row.slug))).json()).coverImageUrl,
    null,
  )
  await error(
    await request(olderUrl, 'GET', undefined, admin),
    404,
    'NOT_FOUND',
  )
  await error(
    await request(imagePath(catalogProduct(row.slug))),
    404,
    'NOT_FOUND',
  )
  const stored = await db.product.findUniqueOrThrow({ where: { id: row.id } })
  assert.equal(stored.listed, true)
  assert.equal(stored.priceFen, row.priceFen)
})

test('an audit failure rolls back both replacement and deletion and leaves the original bytes readable', async () => {
  const row = await product()
  const saved = await upload(row.id, await image('png'))
  assert.equal(saved.status, 200)
  const { coverImageUrl } = await saved.json()
  const previous = await db.product.findUniqueOrThrow({ where: { id: row.id } })
  const oldBytes = await bytes(
    await request(coverImageUrl, 'GET', undefined, admin),
  )
  sql(
    "CREATE TRIGGER Cover_test_outage BEFORE INSERT ON AdminAuditLog FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ISOLATED_COVER_TEST_FAILURE';",
  )
  try {
    await error(
      await upload(row.id, await image('png', 90, 55)),
      503,
      'UNAVAILABLE',
    )
    await error(await remove(row.id), 503, 'UNAVAILABLE')
  } finally {
    sql('DROP TRIGGER Cover_test_outage;')
  }
  assert.deepEqual(
    await db.product.findUniqueOrThrow({ where: { id: row.id } }),
    previous,
  )
  assert.deepEqual(
    await bytes(await request(coverImageUrl, 'GET', undefined, admin)),
    oldBytes,
  )
  assert.equal(await db.adminAuditLog.count({ where: { entityId: row.id } }), 1)
})

test('concurrent replacements publish only valid immutable blobs and keep older blobs for recovery', async () => {
  const row = await product()
  const original = await upload(row.id, await image('png', 70, 40))
  assert.equal(original.status, 200)
  const first = await db.product.findUniqueOrThrow({ where: { id: row.id } })
  const writes = await Promise.all(
    [81, 127].map(async (width) =>
      upload(row.id, await image('png', width, 50)),
    ),
  )
  assert.deepEqual(
    writes.map((response) => response.status),
    [200, 200],
  )
  const results = await Promise.all(writes.map((response) => response.json()))
  assert.notEqual(results[0].coverImageUrl, results[1].coverImageUrl)
  const latest = (
    await (await request(adminProduct(row.id), 'GET', undefined, admin)).json()
  ).product
  assert(
    results.some((result) => result.coverImageUrl === latest.coverImageUrl),
  )
  const served = await request(latest.coverImageUrl, 'GET', undefined, admin)
  assert.equal(served.status, 200)
  assert(
    [81, 127].includes((await sharp(await bytes(served)).metadata()).width!),
  )
  assert((await readdir(root)).includes(first.coverImageKey!))
  assert.equal(
    await db.adminAuditLog.count({
      where: { entityId: row.id, action: 'PRODUCT_COVER_REPLACED' },
    }),
    2,
  )
})

test('traversal keys, directory links and non-owned hard links cannot be used as images', async () => {
  const row = await product()
  const outside = join(dirname(root), 'outside-cover-fixture')
  const foreign = join(outside, 'fixture.webp')
  const alias = join(root, randomUUID() + '.webp')
  const hard = join(root, randomUUID() + '.webp')
  await mkdir(root, { recursive: true })
  await mkdir(outside)
  await writeFile(foreign, await image('webp'), { flag: 'wx' })
  try {
    await symlink(
      outside,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await link(foreign, hard)
    for (const bad of [
      '../outside-cover-fixture/fixture.webp',
      alias.split(/[\\/]/).at(-1)!,
      hard.split(/[\\/]/).at(-1)!,
    ]) {
      await db.product.update({
        where: { id: row.id },
        data: { coverImageKey: bad },
      })
      await error(
        await request(imagePath(catalogProduct(row.slug))),
        404,
        'NOT_FOUND',
      )
      await error(
        await request(imagePath(adminProduct(row.id)), 'GET', undefined, admin),
        503,
        'PRODUCT_COVER_STORAGE_UNAVAILABLE',
      )
    }
  } finally {
    for (const target of [alias, hard, foreign])
      await unlink(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    await rmdir(outside)
  }
})

test('image mutations retain stale checkout protection and do not populate order snapshots', async () => {
  const row = await product()
  const prior = row.updatedAt.toISOString()
  const create = (expectedProductUpdatedAt: string) =>
    request(
      '/api/v1/customer/orders',
      'POST',
      {
        productId: row.id,
        expectedProductUpdatedAt,
        formData: {},
      },
      customer,
    )
  const result = await upload(row.id, await image('webp'))
  assert.equal(result.status, 200)
  const afterUpload = (await result.json()).updatedAt
  await error(await create(prior), 409, 'PRODUCT_CHANGED')
  const deleted = await remove(row.id)
  assert.equal(deleted.status, 200)
  const afterDelete = (await deleted.json()).updatedAt
  await error(await create(afterUpload), 409, 'PRODUCT_CHANGED')
  const success = await create(afterDelete)
  assert.equal(success.status, 201)
  const { order } = await success.json()
  assert.equal(order.amountFen, row.priceFen)
  assert.equal(Object.hasOwn(order, 'coverImageKey'), false)
  assert.equal(Object.hasOwn(order, 'coverImageUrl'), false)
})
