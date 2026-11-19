import { expect, test, type Page, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import { businessInput } from '../frontend/src/stores/business-time.ts'
const env = integrationEnvironment()
const headers = {
  Origin: env.APP_BASE_URL,
  'X-Requested-With': 'MembershipStore',
}
const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString()
test.use({ actionTimeout: 15000 })
async function choose(page: Page, locator: Locator, label: string) {
  // Search through the real remote selector instead of scrolling a growing
  // cross-suite catalog inside a small mobile dialog. Keep exact option matching.
  const search = label.split(' · ')[0]!
  if ((await locator.isEditable()) && (await locator.inputValue()) !== search) {
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'GET' &&
        /^\/api\/v1\/admin\/(users|products)$/.test(url.pathname) &&
        url.searchParams.get('search') === search
      )
    })
    await locator.fill(search)
    expect((await loaded).status()).toBe(200)
  }
  await locator.press('ArrowDown')
  await page.getByRole('option', { name: label, exact: true }).click()
}
test('real subscription creation, frozen eight-field data, editing, renewal, archive maintenance and termination', async ({
  page,
}, info) => {
  test.setTimeout(150000)
  page.on('pageerror', (error) => {
    throw error
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== env.APP_BASE_URL)
      throw new Error('External requests forbidden')
    if (
      /\/api\/v1\/(admin\/orders|admin\/payment|auth\/activate)/.test(
        url.pathname,
      )
    )
      throw new Error('Out-of-scope operation')
  })
  await page.goto('/admin/login')
  await page.getByLabel('登录邮箱', { exact: true }).fill(env.ADMIN_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(env.ADMIN_PASSWORD)
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/auth/login' &&
        response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ])
  expect(login.status()).toBe(200)
  await expect(page).toHaveURL('/admin/users')
  const tag = info.project.name + '-' + randomUUID(),
    name = '订阅验收-' + tag,
    label = '待激活-' + tag
  const userResponse = await page.request.post('/api/v1/admin/users', {
    headers,
    data: { adminLabel: label, loginEmail: randomUUID() + '@example.com' },
  })
  expect(userResponse.status()).toBe(201)
  const user = (await userResponse.json()).user
  const schema = {
    version: 1,
    fields: [
      { id: 'text', type: 'text', label: '服务标识', required: true },
      { id: 'email', type: 'email', label: '联系邮箱', required: true },
      { id: 'textarea', type: 'textarea', label: '服务说明', required: false },
      {
        id: 'select',
        type: 'select',
        label: '下拉方案',
        required: true,
        options: [{ value: 'a', label: '下拉 A' }],
      },
      {
        id: 'radio',
        type: 'radio',
        label: '单选方案',
        required: true,
        options: [{ value: 'b', label: '单选 B' }],
      },
      {
        id: 'checkbox',
        type: 'checkbox',
        label: '多选方案',
        required: true,
        options: [{ value: 'c', label: '多选 C' }],
      },
      { id: 'number', type: 'number', label: '服务数量', required: true },
      { id: 'date', type: 'date', label: '服务日期', required: true },
    ],
  }
  const productResponse = await page.request.post('/api/v1/admin/products', {
    headers,
    data: {
      name,
      description: '创建时介绍',
      type: 'SUBSCRIPTION',
      priceFen: 1234,
      renewalPriceFen: 999,
      termLabel: '人工确认周期',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      listed: false,
      formSchema: schema,
    },
  })
  expect(productResponse.status()).toBe(201)
  const product = (await productResponse.json()).product
  await page.goto('/admin/subscriptions')
  await expect(
    page.getByRole('heading', { name: '订阅管理', exact: true }),
  ).toBeVisible()
  const settingsResponse = await page.request.get('/api/v1/admin/settings')
  expect(settingsResponse.status()).toBe(200)
  const timezone = (await settingsResponse.json()).settings.timezone
  await page.getByRole('button', { name: '新增订阅', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新增订阅', exact: true })
  await choose(
    page,
    create.getByRole('combobox', { name: '订阅客户', exact: true }),
    label + ' · 待激活',
  )
  await choose(
    page,
    create.getByRole('combobox', { name: '订阅商品', exact: true }),
    name + ' · 未上架',
  )
  await create
    .getByLabel('订阅开始时间', { exact: true })
    .fill(businessInput(days(-1), timezone))
  await create
    .getByLabel('订阅到期时间', { exact: true })
    .fill(businessInput(days(20), timezone))
  await expect(create.getByLabel('订阅续订价格', { exact: true })).toHaveValue(
    '9.99',
  )
  await create
    .getByLabel('服务信息 服务标识', { exact: true })
    .fill('非敏感标识')
  await create
    .getByLabel('服务信息 联系邮箱', { exact: true })
    .fill('service@example.com')
  await create
    .getByLabel('服务信息 服务说明', { exact: true })
    .fill('<b>按文本展示</b>')
  await choose(
    page,
    create.getByRole('combobox', { name: '服务信息 下拉方案', exact: true }),
    '下拉 A',
  )
  await create.getByText('单选 B', { exact: true }).click()
  await expect(
    create.getByRole('radio', { name: '单选 B', exact: true }),
  ).toBeChecked()
  await create.getByText('多选 C', { exact: true }).click()
  await expect(
    create.getByRole('checkbox', { name: '多选 C', exact: true }),
  ).toBeChecked()
  await create.getByLabel('服务信息 服务数量', { exact: true }).fill('2.5')
  await create
    .getByLabel('服务信息 服务日期', { exact: true })
    .fill('2028-02-29')
  await create.getByLabel('订阅备注', { exact: true }).fill('仅隔离数据库验收')
  const creating = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/admin/subscriptions',
  )
  await create.getByRole('button', { name: '保存订阅', exact: true }).click()
  const created = await creating
  expect(created.status()).toBe(201)
  expect(created.request().headers()['idempotency-key']).toBeTruthy()
  const subscription = (await created.json()).subscription
  await expect(create).not.toBeVisible()
  await page.reload()
  await page.getByRole('textbox', { name: '搜索订阅', exact: true }).fill(name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const row = page.locator('tbody tr').filter({ hasText: subscription.id })
  await expect(row).toContainText(label)
  await expect(row).toContainText('¥9.99')
  // Product edits cannot replace the old snapshot or its validator/renderer.
  expect(
    (
      await page.request.patch('/api/v1/admin/products/' + product.id, {
        headers,
        data: {
          name: '后续改名-' + tag,
          description: '后续介绍',
          formSchema: {
            version: 1,
            fields: [
              { id: 'new', type: 'text', label: '新字段', required: true },
            ],
          },
        },
      })
    ).status(),
  ).toBe(200)
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑订阅', exact: true })
  await expect(
    edit.getByLabel('服务信息 服务标识', { exact: true }),
  ).toHaveValue('非敏感标识')
  await expect(edit.getByLabel('服务信息 新字段', { exact: true })).toHaveCount(
    0,
  )
  await edit.getByLabel('服务信息 服务标识', { exact: true }).fill('维护原快照')
  await edit.getByLabel('订阅续订价格', { exact: true }).fill('10.50')
  await edit.getByLabel('订阅操作原因', { exact: true }).fill('人工维护')
  await edit.getByRole('button', { name: '保存订阅', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await row.getByRole('button', { name: '直接续订', exact: true }).click()
  const renew = page.getByRole('dialog', { name: '直接续订', exact: true })
  await renew
    .getByLabel('订阅到期时间', { exact: true })
    .fill(businessInput(days(45), timezone))
  await renew
    .getByLabel('订阅操作原因', { exact: true })
    .fill('人工确认新的到期时间')
  await renew.getByRole('button', { name: '确认直接续订', exact: true }).click()
  await expect(renew).not.toBeVisible()
  expect(
    (
      await page.request.post(
        '/api/v1/admin/products/' + product.id + '/archive',
        { headers, data: {} },
      )
    ).status(),
  ).toBe(200)
  await page.reload()
  await page.getByRole('textbox', { name: '搜索订阅', exact: true }).fill(name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(row).toContainText('商品已归档')
  const productFilter = page.getByRole('combobox', {
    name: '筛选订阅商品',
    exact: true,
  })
  await productFilter.scrollIntoViewIfNeeded()
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === '/api/v1/admin/products' &&
      url.searchParams.get('search') === '后续改名-' + tag
    )
  })
  await productFilter.fill('后续改名-' + tag)
  expect((await filtered).status()).toBe(200)
  await choose(page, productFilter, '后续改名-' + tag)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(
    row.getByRole('button', { name: '直接续订', exact: true }),
  ).toHaveCount(0)
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await edit
    .getByLabel('订阅备注', { exact: true })
    .fill('归档商品仍可维护服务')
  await edit.getByLabel('订阅操作原因', { exact: true }).fill('归档后维护')
  await edit.getByRole('button', { name: '保存订阅', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await row.getByRole('button', { name: '立即取消', exact: true }).click()
  const cancel = page.getByRole('dialog', { name: '立即取消', exact: true })
  await expect(cancel).toContainText('不可恢复')
  await cancel.getByLabel('订阅操作原因', { exact: true }).fill('验收结束')
  await cancel
    .getByRole('button', { name: '确认立即取消', exact: true })
    .click()
  await expect(cancel).not.toBeVisible()
  await expect(row).toContainText('已终止')
  await expect(
    row.getByRole('button', { name: '编辑', exact: true }),
  ).toHaveCount(0)
  await row.getByRole('button', { name: '详情', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '订阅详情', exact: true })
  await expect(detail).toContainText(name)
  await expect(detail).toContainText('创建时介绍')
  await expect(detail).toContainText('¥12.34（非实付金额）')
  await expect(detail).toContainText('操作历史')
  await expect(detail).toContainText('直接续订')
  await expect(
    detail.getByLabel('服务信息 服务标识', { exact: true }),
  ).toHaveValue('维护原快照')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/subscriptions-' + info.project.name + '.png',
    fullPage: true,
  })
  const records = await page.request.get(
    '/api/v1/admin/subscriptions?userId=' + user.id,
  )
  expect((await records.json()).total).toBe(1)
})
