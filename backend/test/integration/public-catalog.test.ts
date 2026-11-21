import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const keys = [
  'description',
  'name',
  'priceFen',
  'renewalPriceFen',
  'servicePeriodCount',
  'servicePeriodUnit',
  'slug',
  'termLabel',
  'type',
]
const fixture = {
  slug: 'alpha-subscription',
  name: 'Alpha Plus 100%_ready\\path',
  description: 'Guest-facing description',
  type: 'SUBSCRIPTION',
  priceFen: 1200,
  renewalPriceFen: 900,
  termLabel: '按月',
  servicePeriodUnit: 'MONTH',
  servicePeriodCount: 1,
} as const
const oneTime = {
  ...fixture,
  type: 'ONE_TIME',
  renewalPriceFen: null,
  servicePeriodUnit: null,
  servicePeriodCount: null,
} as const
let server: Server
let endpoint: string

before(async () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const tied = { listed: true, createdAt, sortOrder: 2 }
  await db.product.createMany({
    data: [
      {
        ...fixture,
        ...tied,
        id: 'catalog-b',
        targetField: 'EMAIL',
        formSchema: {
          version: 1,
          fields: [{ defaultValue: 'nonpublic fixture' }],
        },
      },
      {
        ...oneTime,
        ...tied,
        id: 'catalog-a',
        slug: 'alpha-once',
        name: 'Alpha Set up',
      },
      {
        ...oneTime,
        ...tied,
        slug: 'beta-once',
        name: 'Beta 100X_ready\\path',
        description: 'Alpha appears only in the description',
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
      },
      {
        ...fixture,
        ...tied,
        slug: 'gamma-subscription',
        name: 'Gamma 100%Xready\\path',
        sortOrder: 1,
      },
      { ...fixture, slug: 'alpha-unlisted', listed: false },
      {
        ...fixture,
        slug: 'alpha-archived',
        listed: false,
        archivedAt: createdAt,
      },
    ],
  })
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  endpoint = 'http://127.0.0.1:' + address.port + '/api/v1/catalog/products'
})

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    )
  await db.$disconnect()
})

async function page(query = '') {
  const response = await fetch(endpoint + query)
  assert.equal(response.status, 200)
  return (await response.json()) as {
    items: { slug: string; renewalPriceFen: number | null }[]
    total: number
    page: number
    pageSize: number
  }
}

test('guests see only listed and unarchived products with the exact public projection', async () => {
  const result = await page()
  assert.deepEqual(Object.keys(result).sort(), [
    'items',
    'page',
    'pageSize',
    'total',
  ])
  assert.equal(result.total, 4)
  assert.equal(result.page, 1)
  assert.equal(result.pageSize, 20)
  for (const product of result.items)
    assert.deepEqual(Object.keys(product).sort(), keys)
  assert.deepEqual(
    result.items.find((item) => item.slug === fixture.slug),
    fixture,
  )
  assert.equal(
    result.items.find((item) => item.slug === 'alpha-once')?.renewalPriceFen,
    null,
  )
  const response = await fetch(endpoint + '/' + fixture.slug)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), fixture)
})

test('guest detail gives the same 404 for missing, unlisted and archived slugs', async () => {
  for (const slug of ['unknown', 'alpha-unlisted', 'alpha-archived']) {
    const response = await fetch(endpoint + '/' + slug)
    assert.equal(response.status, 404, slug)
    const { error } = await response.json()
    assert.equal(error.code, 'NOT_FOUND', slug)
    assert.equal(error.message, '商品不存在', slug)
  }
})

test('search trims, matches only names and AND-combines type and visibility', async () => {
  const alpha = await page('?search=%20Alpha%20')
  assert.deepEqual(
    alpha.items.map((item) => item.slug),
    ['alpha-once', 'alpha-subscription'],
  )
  const result = await page('?search=%20Alpha%20&type=SUBSCRIPTION&pageSize=1')
  assert.deepEqual(result, { items: [fixture], total: 1, page: 1, pageSize: 1 })
  assert.equal((await page('?search=%20%20')).total, 4)
})

test('search treats percent, underscore and backslash as literal name characters', async () => {
  const result = await page(
    '?' + new URLSearchParams({ search: '100%_ready\\path' }),
  )
  assert.deepEqual(result, {
    items: [fixture],
    total: 1,
    page: 1,
    pageSize: 20,
  })
})

test('strict query validation enforces types, size and pagination bounds', async () => {
  for (const query of [
    'search=' + 'a'.repeat(121),
    'search=a&search=b',
    'type=subscription',
    'type=ALL',
    'type=ONE_TIME&type=SUBSCRIPTION',
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1e1',
    'page=10001',
    'page=1&page=2',
    'pageSize=0',
    'pageSize=101',
    'pageSize=2.5',
    'listed=false',
    'archivedAt=null',
    'sort=desc',
  ]) {
    const response = await fetch(endpoint + '?' + query)
    assert.equal(response.status, 400, query)
    assert.equal((await response.json()).error.code, 'INVALID_INPUT', query)
  }
  assert.equal((await page('?search=%20' + 'a'.repeat(120) + '%20')).total, 0)
  assert.deepEqual(await page('?type=ONE_TIME&page=10000&pageSize=100'), {
    items: [],
    total: 2,
    page: 10000,
    pageSize: 100,
  })
})

test('stable ordering breaks sortOrder ties by creation time and then ID across pages', async () => {
  const first = await page('?page=1&pageSize=2')
  const second = await page('?page=2&pageSize=2')
  assert.deepEqual(
    first.items.map((item) => item.slug),
    ['gamma-subscription', 'beta-once'],
  )
  assert.deepEqual(
    second.items.map((item) => item.slug),
    ['alpha-once', 'alpha-subscription'],
  )
  assert.equal(first.total, 4)
  assert.equal(second.total, 4)
  assert.equal(second.page, 2)
  assert.equal(second.pageSize, 2)
  assert.deepEqual(await page('?page=3&pageSize=2'), {
    items: [],
    total: 4,
    page: 3,
    pageSize: 2,
  })
})
