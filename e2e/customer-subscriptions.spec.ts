import { expect, test, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const subscriptionsPath = '/api/v1/customer/subscriptions'
test.afterAll(() => db.$disconnect())

async function signIn(context: BrowserContext, userId: string) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
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
}

async function customer() {
  return db.user.create({
    data: { loginEmail: randomUUID() + '@example.test', status: 'ACTIVE' },
  })
}

test('the customer sees the fulfilled subscription and can open its own source order', async ({
  page,
  context,
}) => {
  const [owner, admin] = await Promise.all([
    customer(),
    db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
  ])
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Browser subscription',
      type: 'SUBSCRIPTION',
      priceFen: 0,
      renewalPriceFen: 8800,
      termLabel: '按月服务',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      formSchema: { version: 1, fields: [] },
    },
  })
  await signIn(context, admin.id)
  const post = (url: string, data: object) =>
    page.request.post(url, {
      headers: {
        Origin: env.APP_BASE_URL,
        'X-Requested-With': 'MembershipStore',
        'Idempotency-Key': randomUUID(),
      },
      data,
    })
  const created = await post('/api/v1/admin/orders', {
    userId: owner.id,
    productId: product.id,
    amountFen: 0,
    formData: {},
    internalNote: 'PRIVATE_BROWSER_NOTE',
  })
  expect(created.status()).toBe(201)
  const { order } = await created.json()
  const fulfilled = await post(
    '/api/v1/admin/orders/' + order.id + '/fulfill',
    { expectedVersion: 1 },
  )
  expect(fulfilled.status()).toBe(200)
  const { subscription } = await fulfilled.json()

  await db.subscription.create({
    data: {
      userId: owner.id,
      productId: product.id,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Terminated test subscription',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 0,
      termSnapshot: 'Historical period',
      renewalPriceFen: 6600,
      status: 'TERMINATED',
      startedAt: new Date(Date.now() - 86400000),
      expiresAt: new Date(Date.now() + 86400000),
      terminatedAt: new Date(),
      terminationReason: 'PRIVATE_BROWSER_REASON',
    },
  })
  await signIn(context, owner.id)
  await page.goto('/subscriptions')
  await expect(page.getByRole('heading', { name: '我的订阅' })).toBeVisible()
  await expect(page.locator('.subscription-card')).toHaveCount(2)
  await page.getByRole('button', { name: '已终止', exact: true }).click()
  await expect(page.locator('.subscription-card')).toHaveCount(1)
  await expect(
    page.getByRole('heading', { name: 'Terminated test subscription' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '有效', exact: true }).click()
  const card = page.locator('.subscription-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Browser subscription')
  await expect(card).toContainText('88.00')
  await page.route(
    (url) => url.pathname === subscriptionsPath + '/' + subscription.id,
    (route) => route.fulfill({ status: 503, json: {} }),
    { times: 1 },
  )
  await card.getByRole('button', { name: '详情', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '订阅详情' })
  await expect(dialog.getByRole('alert')).toContainText('无法读取订阅详情')
  await dialog.getByRole('button', { name: '重试详情' }).click()
  await expect(dialog).toContainText('Browser subscription')
  await expect(dialog).toContainText('开始时间')
  await expect(dialog).toContainText('到期时间')
  await expect(dialog).not.toContainText('PRIVATE_BROWSER_NOTE')
  await expect(
    dialog.getByRole('link', { name: order.orderNo }),
  ).toHaveAttribute('href', '/account/orders?orderId=' + order.id)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await dialog.getByRole('link', { name: order.orderNo }).click()
  expect(order.orderNo).toMatch(/^[1-9][0-9]{8}$/)
  await expect(page.getByRole('dialog', { name: '订单详情' })).toContainText(
    order.orderNo.match(/.{3}/g)!.join(' '),
  )

  const stranger = await customer()
  await signIn(context, stranger.id)
  const denied = await page.request.get(
    subscriptionsPath + '/' + subscription.id,
  )
  expect(denied.status()).toBe(404)
  await page.goto('/subscriptions')
  await expect(page.getByText('暂无订阅', { exact: true })).toBeVisible()
})

test('list loading, failure and retry use the own-subscription API', async ({
  page,
  context,
}) => {
  await signIn(context, (await customer()).id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === subscriptionsPath,
    async (route) => {
      await gate
      await route.fulfill({ status: 503, json: {} })
    },
    { times: 1 },
  )
  try {
    await page.goto('/subscriptions')
    await expect(page.getByRole('status')).toContainText('正在读取订阅')
  } finally {
    release()
  }
  await expect(page.getByRole('alert')).toContainText('无法读取订阅')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText('暂无订阅', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '已到期', exact: true }).click()
  await expect(
    page.getByText('暂无符合条件的订阅', { exact: true }),
  ).toBeVisible()
})
