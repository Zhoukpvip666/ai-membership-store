import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '../backend/src/generated/prisma/client.ts'
import { createDatabase } from '../backend/src/db/client.ts'
import {
  COOKIE_NAME,
  hashPassword,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'
import { purchaseSchema } from '../backend/test/integration/purchase-fixture.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const fixturePassword = 'FictionalPurchaseFixture456!'
const purchaseApi = '/api/v1/customer/products/'
test.afterAll(() => db.$disconnect())

async function product(overrides: Partial<Prisma.ProductCreateInput> = {}) {
  const slug = 'purchase-' + randomUUID()
  return db.product.create({
    data: {
      slug,
      name: '购买验收 ' + slug.slice(-8),
      description: '<b>商品介绍</b>',
      type: 'SUBSCRIPTION',
      priceFen: 9900,
      renewalPriceFen: 8800,
      termLabel: '按月服务',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      listed: true,
      formSchema: purchaseSchema,
      ...overrides,
    },
  })
}

async function customer(login = false) {
  return db.user.create({
    data: {
      loginEmail: randomUUID() + '@purchase.example',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      ...(login ? { passwordHash: await hashPassword(fixturePassword) } : {}),
    },
  })
}

async function signInSession(context: BrowserContext, userId: string) {
  const token = newToken()
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  return session.id
}

const input = (page: Page, label: string) =>
  page.getByLabel('服务信息 ' + label, { exact: true })
const buy = (page: Page) =>
  page.getByRole('button', { name: '立即购买', exact: true })
const check = (page: Page) =>
  page.getByRole('button', { name: '检查填写信息', exact: true })

async function expectLogin(page: Page, destination: string) {
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('redirect') === destination,
  )
}

async function logIn(page: Page, email: string) {
  await page.getByLabel('登录邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('guest buys from detail and returns to the same product after real login', async ({
  page,
}) => {
  const [item, user] = await Promise.all([product(), customer(true)])
  const destination = '/purchase/' + item.slug
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(purchaseApi)) reads.push(path)
  })
  await page.goto('/products/' + item.slug)
  await expect(buy(page)).toBeEnabled()
  await expect(input(page, '账号标识')).toHaveCount(0)
  expect(reads).toEqual([])
  await buy(page).click()
  await expectLogin(page, destination)
  expect(reads).toEqual([])
  await db.product.update({ where: { id: item.id }, data: { priceFen: 4900 } })
  await logIn(page, user.loginEmail)
  await expect(page).toHaveURL(destination)
  await expect(input(page, '账号标识')).toBeVisible()
  await expect(page.getByRole('heading', { name: item.name })).toBeVisible()
  await expect(page.locator('.purchase-content')).toContainText('49.00')
  await expect(page.locator('.purchase-content')).toContainText('88.00')
  await expect(page.locator('.purchase-content')).toContainText('1 个月')
  await expect(page.locator('.purchase-content')).toContainText(
    item.description!,
  )
  await expect(page.locator('.product-description b')).toHaveCount(0)
  expect(reads).toEqual([purchaseApi + item.slug])
})

test('direct purchase requires a customer Session and sends ADMIN to order management', async ({
  page,
  context,
}) => {
  const [item, admin] = await Promise.all([
    product(),
    db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
  ])
  const destination = '/purchase/' + item.slug
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(purchaseApi)) reads.push(path)
  })
  await page.goto(destination)
  await expectLogin(page, destination)
  await signInSession(context, admin.id)
  await page.goto(destination)
  await expect(page).toHaveURL('/admin/orders')
  expect(reads).toEqual([])
})

test('login rejects external, traversal and encoded redirect destinations', async ({
  page,
  context,
}) => {
  const user = await customer(true)
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === env.APP_BASE_URL
      ? route.continue()
      : route.abort(),
  )
  for (const target of [
    'https://evil.example',
    '//evil.example',
    '/purchase/../admin',
    '/purchase/a%2Fb',
  ]) {
    await page.goto('/login?' + new URLSearchParams({ redirect: target }))
    await logIn(page, user.loginEmail)
    await expect(page).toHaveURL('/profile')
  }
})

test('signed-in buyer sees eight empty inputs and checks values locally', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  await signInSession(context, user.id)
  const requests: string[] = []
  let checkedInputs = false
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (checkedInputs && path.startsWith('/api/')) requests.push(path)
  })
  await page.goto('/products/' + item.slug)
  await buy(page).click()
  await expect(page).toHaveURL('/purchase/' + item.slug)
  const handle = input(page, '账号标识')
  await expect(handle).toBeVisible()
  for (const label of ['账号标识', '联系邮箱', '补充说明', '数量', '起始日期'])
    await expect(input(page, label)).toHaveValue('')
  const region = page.getByRole('combobox', { name: '服务信息 地区' })
  const radio = page.getByRole('radio', { name: '邮件' })
  const checkbox = page.getByRole('checkbox', { name: '学习' })
  await expect(region).toBeVisible()
  await expect(page.locator('.purchase-form')).not.toContainText('亚洲')
  await expect(radio).not.toBeChecked()
  await expect(checkbox).not.toBeChecked()
  await expect(
    page.getByText('<b>请输入公开标识</b>', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.purchase-form b')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)

  checkedInputs = true
  await check(page).click()
  await expect(page.getByRole('alert')).toContainText('账号标识 · 请填写必填项')
  await handle.fill('API key: fictional-input-only')
  await input(page, '联系邮箱').fill('invalid-email')
  await input(page, '数量').fill('9007199254740992')
  await check(page).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('账号标识 · 不得填写认证凭证')
  await expect(alert).toContainText('联系邮箱 · 请输入有效的邮箱地址')
  await expect(alert).toContainText('数量 · 请输入有效范围内的数字')
  await expect(alert).not.toContainText('fictional-input-only')

  await handle.fill('public-profile')
  await input(page, '联系邮箱').fill('fixture@example.com')
  await input(page, '补充说明').fill('可公开的补充说明')
  await input(page, '数量').fill('2.5')
  await input(page, '起始日期').fill('2028-02-29')
  await region.press('ArrowDown')
  await page.getByRole('option', { name: '亚洲', exact: true }).click()
  await page.getByText('邮件', { exact: true }).click()
  await page.getByText('学习', { exact: true }).click()
  await expect(radio).toBeChecked()
  await expect(checkbox).toBeChecked()
  await check(page).click()
  await expect(page.getByRole('status')).toContainText('填写信息已通过检查')
  expect(requests).toEqual([])
  expect(await db.order.count({ where: { userId: user.id } })).toBe(0)
})

test('leaving purchase discards the draft and a different product loads its own form', async ({
  page,
  context,
}) => {
  const [first, second, user] = await Promise.all([
    product(),
    product({
      formSchema: {
        version: 1,
        fields: [
          { id: 'next', type: 'text', label: '另一商品标识', required: true },
        ],
      },
    }),
    customer(),
  ])
  await signInSession(context, user.id)
  await page.goto('/purchase/' + first.slug)
  const marker = 'memory-only-draft-' + randomUUID()
  await input(page, '账号标识').fill(marker)
  expect(
    await page.evaluate(
      (text) =>
        [localStorage, sessionStorage].some((storage) =>
          Object.values(storage).some((value) => value.includes(text)),
        ),
      marker,
    ),
  ).toBe(false)
  expect(page.url()).not.toContain(marker)
  await page.getByRole('link', { name: '返回商品详情' }).click()
  await buy(page).click()
  await expect(input(page, '账号标识')).toHaveValue('')
  await page.getByRole('link', { name: '返回商品详情' }).click()
  await page.getByRole('link', { name: '返回商品目录' }).click()
  await page
    .getByRole('textbox', { name: '搜索商品', exact: true })
    .fill(second.name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page
    .getByRole('link', { name: '查看详情：' + second.name, exact: true })
    .click()
  await buy(page).click()
  await expect(page).toHaveURL('/purchase/' + second.slug)
  await expect(input(page, '另一商品标识')).toHaveValue('')
  await expect(input(page, '账号标识')).toHaveCount(0)
})

test('purchase renders no form while loading or when the product is unavailable', async ({
  page,
  context,
}) => {
  const [item, unsafe, user] = await Promise.all([
    product(),
    product({
      formSchema: {
        version: 1,
        fields: [
          {
            id: 'password',
            type: 'text',
            label: '不能公开的字段',
            required: true,
          },
        ],
      },
    }),
    customer(),
  ])
  await signInSession(context, user.id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === purchaseApi + item.slug,
    async (route) => {
      await gate
      await route.continue()
    },
  )
  try {
    await page.goto('/purchase/' + item.slug)
    await expect(page.getByText('正在加载购买信息…')).toBeVisible()
    await expect(check(page)).toHaveCount(0)
  } finally {
    release()
  }
  await expect(check(page)).toBeVisible()
  await page.goto('/purchase/' + unsafe.slug)
  await expect(page.getByRole('alert')).toContainText(
    '此商品的服务表单暂不可用',
  )
  await expect(input(page, '不能公开的字段')).toHaveCount(0)
  await expect(check(page)).toHaveCount(0)
  await page.goto('/purchase/missing-product')
  await expect(page.getByRole('alert')).toContainText('商品不存在')
  await expect(check(page)).toHaveCount(0)
})

test('revocation between the route guard and purchase GET returns to login with the same path', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  const sessionId = await signInSession(context, user.id)
  await page.route(
    (url) => url.pathname === purchaseApi + item.slug,
    async (route) => {
      await db.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      })
      await route.continue()
    },
    { times: 1 },
  )
  await page.goto('/purchase/' + item.slug)
  await expectLogin(page, '/purchase/' + item.slug)
  await expect(check(page)).toHaveCount(0)
})
