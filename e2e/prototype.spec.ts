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
            role: 'ADMIN',
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
    if (
      [
        '/api/v1/admin/users',
        '/api/v1/admin/products',
        '/api/v1/admin/subscriptions',
      ].includes(path)
    )
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 20 },
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
    ['/orders', '我的订单'],
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
test('unpaid orders are excluded from waiting fulfillment and overview metric', async ({
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
  await page.getByRole('button', { name: '未付款', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  const id = await page.locator('tbody tr .mono').first().innerText()
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '订单详情', exact: true })
  await expect(dialog.locator('.badge')).toHaveText('未付款')
  await expect(
    dialog.getByRole('button', { name: '模拟确认已完成' }),
  ).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close this dialog' }).click()
  await page.getByRole('button', { name: '待发货', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await expect(page.locator('tbody')).not.toContainText(id)
})
test('subscription history details remain available without creating renewal orders', async ({
  page,
}) => {
  await page.goto('/subscriptions')
  await page.getByRole('button', { name: '有效', exact: true }).click()
  await expect(page.locator('.subscription-card')).toHaveCount(3)
  const card = page
    .locator('.subscription-card')
    .filter({ hasText: 'AI 阅读助手' })
  await card.getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '订阅详情' })).toContainText(
    'MOCK-1002',
  )
  await expect(
    page.getByRole('button', { name: '续费', exact: true }),
  ).toHaveCount(0)
})
test('paid completion and refund require explicit simulation steps', async ({
  page,
}) => {
  await page.goto('/admin/orders')
  await page
    .getByRole('textbox', { name: '搜索订单', exact: true })
    .fill('1008')
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await page
    .getByRole('button', { name: '模拟确认已完成', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: '模拟确认服务完成', exact: true })
    .getByRole('button', { name: '确认模拟操作' })
    .click()
  await expect(
    page
      .getByRole('dialog', { name: '订单详情', exact: true })
      .locator('.badge'),
  ).toHaveText('已完成')
  await page
    .getByRole('dialog', { name: '订单详情', exact: true })
    .getByRole('button', { name: 'Close this dialog' })
    .click()
  await page
    .getByRole('textbox', { name: '搜索订单', exact: true })
    .fill('1007')
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await page.getByRole('button', { name: '模拟申请退款', exact: true }).click()
  await page
    .getByRole('dialog', { name: '模拟申请退款', exact: true })
    .getByRole('button', { name: '确认模拟操作' })
    .click()
  await expect(
    page
      .getByRole('dialog', { name: '订单详情', exact: true })
      .locator('.badge'),
  ).toHaveText('待发货')
  await page.getByRole('button', { name: '模拟回执失败' }).click()
  await expect(
    page.getByRole('dialog', { name: '订单详情', exact: true }),
  ).toContainText('模拟退款失败')
  await expect(
    page
      .getByRole('dialog', { name: '订单详情', exact: true })
      .locator('.detail-grid > div')
      .filter({ hasText: '履约状态（模拟）' })
      .locator('dd'),
  ).toHaveText('处理中')
  await page.getByRole('button', { name: '模拟申请退款', exact: true }).click()
  await page
    .getByRole('dialog', { name: '模拟申请退款', exact: true })
    .getByRole('button', { name: '确认模拟操作' })
    .click()
  await page.getByRole('button', { name: '模拟回执成功' }).click()
  await expect(
    page
      .getByRole('dialog', { name: '订单详情', exact: true })
      .locator('.badge'),
  ).toHaveText('已退款')
  const refundedDetail = page.getByRole('dialog', {
    name: '订单详情',
    exact: true,
  })
  await expect(
    refundedDetail
      .locator('.detail-grid > div')
      .filter({ hasText: '付款状态（模拟）' })
      .locator('dd'),
  ).toHaveText('已确认付款')
  await expect(
    refundedDetail
      .locator('.detail-grid > div')
      .filter({ hasText: '履约状态（模拟）' })
      .locator('dd'),
  ).toHaveText('已取消')
  await expect(
    page.getByRole('button', { name: '模拟申请退款', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '模拟确认已完成', exact: true }),
  ).toHaveCount(0)
  await refundedDetail
    .getByRole('button', { name: 'Close this dialog' })
    .click()
  await page
    .getByRole('textbox', { name: '搜索订单', exact: true })
    .fill('1005')
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await expect(
    refundedDetail
      .locator('.detail-grid > div')
      .filter({ hasText: '履约状态（模拟）' })
      .locator('dd'),
  ).toHaveText('已取消')
})
