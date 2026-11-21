import { expect, test, type Page, type Response } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

const catalogPath = '/api/v1/catalog/products'
const marker = '目录验收 ' + randomUUID().slice(0, 8)
const featured = {
  slug: 'catalog-' + randomUUID(),
  name: marker + ' 月度方案',
  description: '<b>服务介绍</b>',
  type: 'SUBSCRIPTION',
  priceFen: 1200,
  renewalPriceFen: 900,
  termLabel: '按月服务',
  servicePeriodUnit: 'MONTH',
  servicePeriodCount: 1,
  listed: true,
  sortOrder: 0,
} as const
const unavailable = {
  ...featured,
  slug: featured.slug + '-hidden',
  name: marker + ' 未上架',
  listed: false,
}

test.beforeAll(async () => {
  const db = createDatabase(integrationEnvironment().DATABASE_URL)
  try {
    await db.product.createMany({
      data: [
        featured,
        ...Array.from({ length: 21 }, (_, index) => ({
          slug: featured.slug + '-' + index,
          name: marker + ' 单次 ' + (index + 1),
          type: 'ONE_TIME' as const,
          priceFen: 990,
          termLabel: '一次性',
          listed: true,
          sortOrder: index + 1,
        })),
        unavailable,
        {
          ...unavailable,
          slug: featured.slug + '-archived',
          name: marker + ' 已归档',
          archivedAt: new Date(),
        },
      ],
    })
  } finally {
    await db.$disconnect()
  }
})

function catalogResponse(response: Response, query: Record<string, string>) {
  const url = new URL(response.url())
  return (
    response.request().method() === 'GET' &&
    url.pathname === catalogPath &&
    Object.entries(query).every(
      ([key, value]) => url.searchParams.get(key) === value,
    )
  )
}

async function checkNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

test('guest catalog loads, then searches, filters and paginates using the public API', async ({
  page,
}, info) => {
  const initial = page.waitForResponse((response) =>
    catalogResponse(response, { page: '1', pageSize: '20' }),
  )
  await page.goto('/')
  expect((await initial).status()).toBe(200)
  const cards = page.locator('.product-card')
  const card = cards.filter({ hasText: featured.name })
  await expect(card).toContainText('订阅服务')
  await expect(card).toContainText('12.00')
  await expect(card).toContainText(featured.description)
  await expect(cards).toHaveCount(20)
  const grid = page.locator('.product-grid')
  expect(
    await grid.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
    ),
  ).toBe(info.project.name === 'mobile-edge' ? 1 : 3)
  await checkNoHorizontalOverflow(page)

  const search = page.getByRole('textbox', { name: '搜索商品', exact: true })
  await search.fill('  ' + marker + '  ')
  const searched = page.waitForResponse((response) =>
    catalogResponse(response, { search: marker }),
  )
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  expect((await searched).status()).toBe(200)
  const filtered = page.waitForResponse((response) =>
    catalogResponse(response, { search: marker, type: 'ONE_TIME', page: '1' }),
  )
  await page.getByRole('button', { name: '一次性服务', exact: true }).click()
  expect((await filtered).status()).toBe(200)
  await expect(page.getByText('21 件商品', { exact: true })).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(cards).toHaveCount(20)
  const second = page.waitForResponse((response) =>
    catalogResponse(response, { search: marker, type: 'ONE_TIME', page: '2' }),
  )
  await page.locator('.catalog-pagination .btn-next').click()
  expect((await second).status()).toBe(200)
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText(marker + ' 单次 21')
  await expect(cards.first()).toContainText('9.90')

  await search.fill(marker + ' 无结果')
  await search.press('Enter')
  await expect(page.getByText('暂无符合条件的商品')).toBeVisible()
  await expect(cards).toHaveCount(0)
  await checkNoHorizontalOverflow(page)
})

test('guest product detail displays public data and offers no purchase or form request', async ({
  page,
}) => {
  const calls: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/v1/') && path !== '/api/v1/auth/me')
      calls.push(path)
  })
  await page.goto('/')
  await page
    .getByRole('link', { name: '查看详情：' + featured.name, exact: true })
    .click()
  await expect(page).toHaveURL('/products/' + featured.slug)
  await expect(
    page.getByRole('heading', { name: featured.name, exact: true }),
  ).toBeVisible()
  const detail = page.locator('.catalog-detail')
  await expect(detail).toContainText(featured.description)
  await expect(detail.locator('.product-description b')).toHaveCount(0)
  await expect(detail).toContainText('1 个月')
  await expect(detail).toContainText('初始价格')
  await expect(detail).toContainText('12.00')
  await expect(detail).toContainText('续费价格')
  await expect(detail).toContainText('9.00')
  await expect(
    detail.getByRole('button', { name: '暂未开放线上购买' }),
  ).toBeDisabled()
  await expect(detail.getByRole('textbox')).toHaveCount(0)
  expect(calls).toEqual([catalogPath, catalogPath + '/' + featured.slug])
  await checkNoHorizontalOverflow(page)

  await page.goto('/products/' + unavailable.slug)
  await expect(page.getByRole('alert')).toContainText('商品不存在')
  await expect(
    page.getByRole('heading', { name: unavailable.name }),
  ).toHaveCount(0)
  await expect(page.getByRole('link', { name: '返回商品目录' })).toBeVisible()
})

test('catalog reports load failure and can retry against the real API', async ({
  page,
}) => {
  await page.route(
    '**' + catalogPath + '?*',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '目录暂时不可用' } },
      }),
    { times: 1 },
  )
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('目录暂时不可用')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(
    page.getByRole('heading', { name: featured.name, exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
