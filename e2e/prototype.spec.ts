import { expect, test } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/auth/me')
      return route.fulfill({
        json: {
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            username: 'Prototype admin',
            loginEmail: 'owner@example.com',
            role: ['/orders', '/account/orders', '/subscriptions'].includes(
              new URL(route.request().frame().url()).pathname,
            )
              ? 'CUSTOMER'
              : 'ADMIN',
            status: 'ACTIVE',
          },
        },
      })
    if (path === '/api/v1/admin/settings')
      return route.fulfill({
        json: {
          settings: {
            id: 1,
            storeName: 'Prototype store',
            ownerEmail: 'owner@example.com',
            timezone: 'Asia/Shanghai',
          },
        },
      })
    if (path === '/api/v1/admin/settings/wechat-payment')
      return route.fulfill({ json: { enabled: false, imageUrl: null } })
    if (
      [
        '/api/v1/admin/orders',
        '/api/v1/customer/orders',
        '/api/v1/admin/users',
        '/api/v1/admin/products',
        '/api/v1/catalog/products',
        '/api/v1/admin/subscriptions',
      ].includes(path)
    )
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 20 },
      })
    if (path === '/api/v1/customer/order-guidance')
      return route.fulfill({
        json: {
          storeName: 'Prototype store',
          businessTimezone: 'Asia/Shanghai',
          paymentInstructions: '',
        },
      })
    if (path === '/api/v1/customer/subscriptions')
      return route.fulfill({
        json: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          businessTimezone: 'Asia/Shanghai',
        },
      })
    throw new Error(
      'Mock history must not call order/subscription business APIs.',
    )
  })
})
test('all ten pages navigate and responsive layouts fit', async ({
  page,
}, info) => {
  for (const [path, title] of [
    ['/', '商品'],
    ['/subscriptions', '我的订阅'],
    ['/account/orders', '我的订单'],
    ['/profile', '个人中心'],
    ['/admin', '经营概览'],
    ['/admin/products', '商品管理'],
    ['/admin/orders', '订单管理'],
    ['/admin/subscriptions', '订阅管理'],
    ['/admin/users', '用户管理'],
    ['/admin/settings', '系统设置'],
  ]) {
    await page.goto(path!)
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  const nav = page.getByRole('navigation', { name: '管理导航' })
  expect(await nav.evaluate((el) => getComputedStyle(el).flexDirection)).toBe(
    info.project.name.startsWith('mobile') ? 'row' : 'column',
  )
})
test('Mock overview retains independent waiting-fulfillment metric', async ({
  page,
}) => {
  await page.goto('/admin')
  await expect(
    page
      .locator('.metric-card')
      .filter({ hasText: '待发货订单' })
      .locator('strong'),
  ).toHaveText('2')
  await page.goto('/admin/orders')
  await expect(page.getByText('暂无符合条件的订单')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '新建订单', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('模拟确认已完成')).toHaveCount(0)
})
test('subscription navigation can show an empty result without a renewal action', async ({
  page,
}) => {
  await page.goto('/subscriptions')
  await page.getByRole('button', { name: '有效', exact: true }).click()
  await expect(
    page.getByText('暂无符合条件的订阅', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.subscription-card')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '续费', exact: true }),
  ).toHaveCount(0)
})
// Real order/payment/refund flows are tested through HTTP/MySQL in
// admin-order-center.spec.ts; the ADMIN route no longer uses Mock actions.
