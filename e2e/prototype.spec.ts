import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  await page.route('**/api/**', () => {
    throw new Error('Mock UI must work without business APIs')
  })
})

test('all ten pages navigate and responsive layouts fit', async ({
  page,
}, info) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: '商品', exact: true }),
  ).toBeVisible()
  const mobile = info.project.name.startsWith('mobile')
  await expect(
    page.getByRole('navigation', { name: '移动端用户导航' }),
  ).toBeVisible({ visible: mobile })
  const grid = page.locator('.product-grid')
  expect(
    (
      await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    ).split(' '),
  ).toHaveLength(mobile ? 1 : 3)
  await page.screenshot({
    path: `test-results/catalog-${info.project.name}.png`,
    fullPage: true,
  })
  for (const [path, title] of [
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
  await page.goto('/admin')
  const nav = page.getByRole('navigation', { name: '管理导航' })
  expect(await nav.evaluate((el) => getComputedStyle(el).flexDirection)).toBe(
    mobile ? 'row' : 'column',
  )
  await page.screenshot({
    path: `test-results/overview-${info.project.name}.png`,
    fullPage: true,
  })
})

test('catalog filters and local checkout create an unpaid snapshot', async ({
  page,
}) => {
  const apiRequests: string[] = []
  page.on('request', (r) => {
    if (/\/api\//.test(r.url())) apiRequests.push(r.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: '一次性服务', exact: true }).click()
  await expect(page.locator('.product-card')).toHaveCount(2)
  await page.getByRole('button', { name: '订阅服务', exact: true }).click()
  await expect(page.locator('.product-card')).toHaveCount(4)
  await page.locator('.product-card').first().getByRole('button').click()
  const dialog = page.getByRole('dialog', { name: '模拟购买', exact: true })
  await dialog.getByRole('button', { name: '创建模拟订单' }).click()
  await expect(dialog).toBeVisible()
  await dialog
    .getByRole('textbox', { name: '服务目标邮箱', exact: true })
    .fill('target@example.com')
  expect(await dialog.locator('input[type=password]').count()).toBe(0)
  await dialog.getByRole('button', { name: '创建模拟订单' }).click()
  await expect(page).toHaveURL('/orders')
  await expect(page.locator('tbody tr')).toHaveCount(6)
  await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '查看详情' })
    .click()
  await expect(page.getByRole('dialog')).toContainText('未确认付款')
  expect(apiRequests).toEqual([])
})

test('product add edit and independent listing controls update storefront', async ({
  page,
}) => {
  await page.goto('/admin/products')
  await page.getByRole('button', { name: '添加商品', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加商品', exact: true })
  await dialog
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill('测试订阅')
  await dialog
    .getByRole('textbox', { name: '售价（元）', exact: true })
    .fill('12.34')
  await dialog
    .getByRole('textbox', { name: '续费价格（元）', exact: true })
    .fill('9.99')
  await dialog.getByRole('button', { name: '保存商品' }).click()
  const row = page.locator('tbody tr').filter({ hasText: '测试订阅' })
  await row.getByRole('button', { name: '编辑' }).click()
  await page
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill('测试订阅已编辑')
  await page.getByRole('button', { name: '保存商品' }).click()
  await expect(row).toContainText('¥12.34')
  await row
    .getByRole('switch', { name: '测试订阅已编辑上架', exact: true })
    .locator('..')
    .click()
  await expect(
    row.getByRole('switch', { name: '测试订阅已编辑新购', exact: true }),
  ).toBeChecked()
  await page.getByRole('link', { name: /返回商店/ }).click()
  await expect(
    page.locator('.product-card').filter({ hasText: '测试订阅已编辑' }),
  ).toHaveCount(0)
  await page.getByRole('link', { name: /管理控制台/ }).click()
  await page.getByRole('link', { name: '商品管理', exact: true }).click()
  await page
    .locator('tbody tr')
    .filter({ hasText: '测试订阅已编辑' })
    .getByRole('switch', { name: '测试订阅已编辑上架', exact: true })
    .locator('..')
    .click()
  await page.getByRole('link', { name: /返回商店/ }).click()
  await expect(
    page.locator('.product-card').filter({ hasText: '测试订阅已编辑' }),
  ).toContainText('¥12.34')
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
  await expect(
    page.getByRole('button', { name: '模拟申请退款', exact: true }),
  ).toHaveCount(0)
})

test('subscriptions filter and delisted product can renew without extending expiry', async ({
  page,
}) => {
  await page.goto('/subscriptions')
  await page.getByRole('button', { name: '有效', exact: true }).click()
  await expect(page.locator('.subscription-card')).toHaveCount(3)
  const card = page
    .locator('.subscription-card')
    .filter({ hasText: 'AI 阅读助手' })
  const expiry = await card
    .locator('.subscription-bottom strong')
    .first()
    .textContent()
  await card.getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '订阅详情' })).toContainText(
    'MOCK-1002',
  )
  await page
    .getByRole('dialog', { name: '订阅详情' })
    .getByRole('button', { name: 'Close this dialog' })
    .click()
  await card.getByRole('button', { name: '续费', exact: true }).click()
  await page.getByRole('button', { name: '创建模拟订单' }).click()
  await expect(page.locator('tbody tr').first()).toContainText('续费')
  await page
    .getByRole('navigation', { name: /用户导航/ })
    .getByRole('link', { name: /订阅/ })
    .click()
  await expect(
    page
      .locator('.subscription-card')
      .filter({ hasText: 'AI 阅读助手' })
      .locator('.subscription-bottom strong')
      .first(),
  ).toHaveText(expiry!)
  const disabled = page
    .locator('.subscription-card')
    .filter({ hasText: 'AI 创作工具' })
  await expect(disabled).toContainText('暂不支持续费')
  await expect(
    disabled.getByRole('button', { name: '续费', exact: true }),
  ).toHaveCount(0)
})

test('user history links and settings are usable', async ({ page }) => {
  await page.goto('/admin/users')
  await page
    .getByRole('textbox', { name: '搜索用户', exact: true })
    .fill('陈予')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: '查看详情' }).click()
  await page.getByRole('link', { name: '查看该用户订单' }).click()
  await expect(page).toHaveURL('/admin/orders?user=u2')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await page.getByRole('link', { name: '系统设置' }).click()
  await page
    .getByRole('textbox', { name: '店铺名称', exact: true })
    .fill('本地测试商店')
  await page.getByRole('button', { name: '保存本地设置' }).click()
  await expect(page.locator('.brand')).toHaveText('本地测试商店')
})
