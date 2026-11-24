import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import sharp from 'sharp'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

const env = integrationEnvironment()
const csrf = { Origin: env.APP_BASE_URL, 'X-Requested-With': 'MembershipStore' }
const detailPath = (slug: string) => '/products/' + slug
const adminProduct = (id: string) => '/api/v1/admin/products/' + id

async function signIn(page: Page) {
  const result = await page.request.post('/api/v1/auth/login', {
    headers: csrf,
    data: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
  })
  expect(result.status()).toBe(200)
}

function picture(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer()
}

async function checkCover(cover: Locator, width: number, height: number) {
  await expect(cover).toBeVisible()
  const image = cover.locator('img')
  await image.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      image.evaluate((el: HTMLImageElement) => [
        el.naturalWidth,
        el.naturalHeight,
      ]),
    )
    .toEqual([width, height])
  await expect(image).toHaveCSS('object-fit', 'cover')
  await expect(image).toHaveCSS('object-position', '50% 50%')
  const box = await cover.boundingBox()
  expect(Math.abs(box!.width / box!.height - 4 / 3)).toBeLessThan(0.02)
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const output = process.env.PRODUCT_COVER_EVIDENCE_DIR
  if (!output || !isAbsolute(output)) return
  await page.screenshot({
    path: join(output, info.project.name + '-' + name + '.png'),
    animations: 'disabled',
  })
}

test('product covers preserve a centered 4:3 layout and fall back for absent or failed images', async ({
  page,
}, info) => {
  const marker = '样图 ' + randomUUID().slice(0, 8)
  const samples = [
    { label: '横图', width: 240, height: 100, color: '#285bd3' },
    { label: '竖图', width: 100, height: 240, color: '#6b47ae' },
    { label: '方图', width: 160, height: 160, color: '#257c6a' },
    { label: '无主图', width: 0, height: 0, color: '' },
  ]
  const db = createDatabase(env.DATABASE_URL)
  const products = await Promise.all(
    samples.map((sample, index) =>
      db.product.create({
        data: {
          slug: 'cover-' + randomUUID(),
          name: marker + ' ' + sample.label,
          description: '商品主图展示测试',
          type: 'ONE_TIME',
          priceFen: 9900,
          termLabel: '一次性',
          listed: true,
          sortOrder: index,
        },
      }),
    ),
  ).finally(() => db.$disconnect())
  await signIn(page)
  for (const [index, product] of products.entries()) {
    const sample = samples[index]
    if (!sample.width) continue
    const response = await page.request.put(
      adminProduct(product.id) + '/cover-image',
      {
        headers: { ...csrf, 'Content-Type': 'application/octet-stream' },
        data: await picture(sample.width, sample.height, sample.color),
      },
    )
    expect(response.status()).toBe(200)
  }
  const storeName = '星桥会员商店'
  expect(
    (
      await page.request.patch('/api/v1/admin/settings', {
        headers: csrf,
        data: { storeName },
      })
    ).status(),
  ).toBe(200)
  await page.context().clearCookies()
  const adminCalls: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/v1/admin/')) adminCalls.push(path)
  })
  await page.goto('/')
  await expect(page.locator('.store-header .brand')).toHaveText(storeName)
  await expect(page.locator('.store-footer')).toHaveText(storeName)
  await expect(page).toHaveTitle(storeName)
  await expect(page.getByText('预览环境', { exact: true })).toHaveCount(0)
  const search = page.getByRole('textbox', { name: '搜索商品', exact: true })
  await search.fill(marker)
  await search.press('Enter')
  const cards = page.locator('.product-card')
  await expect(cards).toHaveCount(4)
  expect(
    await page
      .locator('.product-grid')
      .evaluate(
        (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      ),
  ).toBe(info.project.name === 'mobile-edge' ? 2 : 3)
  for (const [index, product] of products.entries()) {
    const cover = cards
      .filter({ hasText: product.name })
      .locator('.product-cover')
    const sample = samples[index]
    if (!sample.width) {
      await expect(cover.locator('.product-cover-placeholder')).toBeVisible()
      continue
    }
    await expect(cover.locator('img')).toHaveAttribute('loading', 'lazy')
    await checkCover(cover, sample.width, sample.height)
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
  const selected = cards.filter({ hasText: products[0].name })
  const src = await selected.locator('img').getAttribute('src')
  await page.evaluate(() => window.scrollTo(0, 0))
  await screenshot(page, info, 'catalog-cover')
  await selected
    .getByRole('link', { name: '查看详情：' + products[0].name })
    .click()
  await expect(page).toHaveURL(detailPath(products[0].slug))
  const detail = page.locator('.detail-cover')
  await checkCover(detail, samples[0].width, samples[0].height)
  await expect(detail.locator('img')).toHaveAttribute('src', src!)
  await expect(
    page.getByRole('button', { name: '立即购买', exact: true }),
  ).toBeVisible()
  const coverBox = (await detail.boundingBox())!
  const purchaseBox = (await page
    .getByRole('complementary', { name: '价格与购买' })
    .boundingBox())!
  if (info.project.name === 'mobile-edge')
    expect(coverBox.y + coverBox.height).toBeLessThanOrEqual(purchaseBox.y)
  else expect(coverBox.x + coverBox.width).toBeLessThan(purchaseBox.x)
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page).toHaveTitle(storeName)
  await screenshot(page, info, 'detail-cover')

  await page.route(
    (url) =>
      url.pathname ===
      '/api/v1/catalog' + detailPath(products[0].slug) + '/cover-image',
    (route) => route.fulfill({ status: 404 }),
  )
  await page.reload()
  await expect(detail.locator('.product-cover-placeholder')).toBeVisible()

  await page.getByRole('button', { name: '立即购买', exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('redirect') === '/purchase/' + products[0].slug,
  )
  await expect(page.locator('.auth-panel .brand')).toHaveText(storeName)
  await expect(page).toHaveTitle(storeName)
  await expect(
    page.getByText('登录后可继续购买商品、查看自己的订单和订阅。'),
  ).toBeVisible()
  expect(adminCalls).toEqual([])
})

test('admin can queue a cover when creating a product then preview, replace and delete it', async ({
  page,
}, info) => {
  const name = '主图管理 ' + randomUUID().slice(0, 8)
  await signIn(page)
  await page.goto('/admin/products')
  await page.getByRole('button', { name: '添加商品', exact: true }).click()
  const create = page.getByRole('dialog', { name: '添加商品', exact: true })
  await create
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill(name)
  await create
    .getByRole('combobox', { name: '商品类型', exact: true })
    .press('ArrowDown')
  await page.getByRole('option', { name: '一次性服务', exact: true }).click()
  await create
    .getByRole('textbox', { name: '售价（元）', exact: true })
    .fill('42')
  await create
    .getByRole('switch', { name: '商品上架', exact: true })
    .locator('..')
    .click()
  await create.getByLabel('上传主图').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: await picture(160, 80, '#3767cf'),
  })
  await expect(create.getByText('待上传：wide.png')).toBeVisible()
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/admin/products',
  )
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/cover-image'),
  )
  await create.getByRole('button', { name: '保存商品', exact: true }).click()
  const result = await created
  expect(result.status()).toBe(201)
  const { product } = await result.json()
  expect((await uploaded).status()).toBe(200)
  await expect(create).toHaveCount(0)

  const publicData = async () =>
    await (
      await page.request.get('/api/v1/catalog' + detailPath(product.slug))
    ).json()
  const firstUrl = (await publicData()).coverImageUrl
  expect(firstUrl).toBeTruthy()
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑' })
    .click()
  const edit = page.getByRole('dialog', { name: '编辑商品', exact: true })
  const preview = edit.locator('.admin-cover-preview')
  await checkCover(preview, 160, 80)
  await edit.getByLabel('更换主图').setInputFiles({
    name: 'bad.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invalid image bytes'),
  })
  await expect(edit.getByRole('alert')).toContainText('有效的 PNG')
  await checkCover(preview, 160, 80)
  await edit.getByLabel('更换主图').setInputFiles({
    name: 'tall.png',
    mimeType: 'image/png',
    buffer: await picture(70, 150, '#7646bd'),
  })
  await checkCover(preview, 70, 150)
  await screenshot(page, info, 'admin-cover')
  const newUrl = (await publicData()).coverImageUrl
  expect(newUrl).toBeTruthy()
  expect(newUrl).not.toBe(firstUrl)

  await page.goto('/')
  await page.getByRole('textbox', { name: '搜索商品', exact: true }).fill(name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const card = page.locator('.product-card').filter({ hasText: name })
  await checkCover(card.locator('.product-cover'), 70, 150)
  await expect(card.locator('img')).toHaveAttribute('src', newUrl)
  await card.getByRole('link', { name: '查看详情：' + name }).click()
  await checkCover(page.locator('.detail-cover'), 70, 150)

  await page.goto('/admin/products')
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑' })
    .click()
  await edit.getByRole('button', { name: '删除主图', exact: true }).click()
  await expect(preview.locator('.product-cover-placeholder')).toBeVisible()
  expect((await publicData()).coverImageUrl).toBeNull()
  expect((await page.request.get(newUrl)).status()).toBe(404)
  await page.goto(detailPath(product.slug))
  await expect(
    page.locator('.detail-cover .product-cover-placeholder'),
  ).toBeVisible()
})
