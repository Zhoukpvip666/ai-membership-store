import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const password = 'BrowserRegistrationFixture7429!'
const emailAddress = () => randomUUID() + '@example.test'
const registerPath = '/api/v1/auth/register'
test.afterAll(() => db.$disconnect())

const submitButton = (page: Page) =>
  page.getByRole('button', { name: '注册', exact: true })

async function fillRegistration(
  page: Page,
  email: string,
  confirmation = password,
) {
  await page.getByLabel('登录邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(confirmation)
}

test('a guest registers from checkout and immediately places their own order', async ({
  page,
}) => {
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Registration purchase',
      type: 'ONE_TIME',
      priceFen: 1200,
      termLabel: 'One time',
      listed: true,
    },
  })
  const email = emailAddress()
  const destination = '/purchase/' + product.slug
  await page.goto('/products/' + product.slug)
  await page.getByRole('button', { name: '立即购买', exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('redirect') === destination,
  )
  await page.getByRole('link', { name: '立即注册', exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/register' &&
      url.searchParams.get('redirect') === destination,
  )
  await expect(
    page.getByRole('heading', { name: '注册账号', exact: true }),
  ).toBeVisible()
  await expect(page.locator('a[href="/admin/login"]')).toHaveCount(0)
  await expect(page.getByText('密码须为 12～128 个字符。')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)

  const requests: string[][] = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === registerPath)
      requests.push(Object.keys(req.postDataJSON()).sort())
  })
  await fillRegistration(page, email, 'MismatchedRegistrationFixture!')
  await submitButton(page).click()
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致。')
  expect(requests).toHaveLength(0)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await submitButton(page).click()
  await expect(page).toHaveURL(destination)
  expect(requests).toEqual([['email', 'password']])
  const me = await page.request.get('/api/v1/auth/me')
  expect(me.status()).toBe(200)
  const { user } = await me.json()
  expect(user).toMatchObject({
    loginEmail: email,
    role: 'CUSTOMER',
    status: 'ACTIVE',
  })

  await page.getByRole('button', { name: '检查填写信息', exact: true }).click()
  await page.getByRole('button', { name: '确认下单', exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/account/orders' &&
      Boolean(url.searchParams.get('orderId')),
  )
  await expect(page.getByRole('dialog', { name: '订单详情' })).toContainText(
    product.name,
  )
  const orderId = new URL(page.url()).searchParams.get('orderId')!
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
  expect(order.userId).toBe(user.id)
  expect(order.source).toBe('USER')

  expect((await page.request.get('/api/v1/admin/orders')).status()).toBe(403)
  await page.goto('/admin/orders')
  await expect(page).toHaveURL('/profile')
  await expect(
    page.getByRole('heading', { name: '个人中心', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: /管理控制台/ })).toHaveCount(0)
})

test('registration shows an email conflict and preserves the safe return link to login', async ({
  page,
}) => {
  const destination = '/purchase/example'
  await page.goto('/register?' + new URLSearchParams({ redirect: destination }))
  await fillRegistration(page, env.ADMIN_EMAIL)
  await submitButton(page).click()
  await expect(page.getByRole('alert')).toContainText('该邮箱已被使用。')
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
  await page.getByRole('link', { name: '立即登录', exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('redirect') === destination,
  )
})

test('both signup links reject external, encoded, traversal and admin destinations', async ({
  page,
}) => {
  for (const redirect of [
    'https://example.invalid',
    '//example.invalid',
    '/purchase/%2e%2e',
    '/purchase/../admin',
    '/purchase/a%2fb',
    '/%2fexample.invalid',
    '/admin/orders',
  ]) {
    const query = '?' + new URLSearchParams({ redirect })
    await page.goto('/login' + query)
    await expect(
      page.getByRole('link', { name: '立即注册', exact: true }),
    ).toHaveAttribute('href', '/register')
    await page.goto('/register' + query)
    await expect(
      page.getByRole('link', { name: '立即登录', exact: true }),
    ).toHaveAttribute('href', '/login')
  }
  await fillRegistration(page, emailAddress())
  await submitButton(page).click()
  await expect(page).toHaveURL('/')
})

test('a lost registration response can be recovered through login without a second account', async ({
  page,
}) => {
  const email = emailAddress()
  await page.goto('/register?redirect=/profile')
  await page.route(
    (url) => url.pathname === registerPath,
    async (route) => {
      const created = await route.fetch()
      expect(created.status()).toBe(201)
      await route.abort()
    },
    { times: 1 },
  )
  await fillRegistration(page, email)
  await submitButton(page).click()
  await expect(page.getByRole('alert')).toContainText('注册结果尚未确认')
  await page.getByRole('link', { name: '立即登录', exact: true }).click()
  await page.getByLabel('登录邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL('/profile')
  expect(await db.user.count({ where: { loginEmail: email } })).toBe(1)
})

test('a rate-limited response shows retry guidance', async ({ page }) => {
  await page.goto('/register')
  await page.route(
    (url) => url.pathname === registerPath,
    (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '900' },
        json: { error: { code: 'RATE_LIMITED' } },
      }),
  )
  await fillRegistration(page, emailAddress())
  await submitButton(page).click()
  await expect(page.getByRole('alert')).toContainText('注册尝试过于频繁')
  await expect(submitButton(page)).toBeEnabled()
})
