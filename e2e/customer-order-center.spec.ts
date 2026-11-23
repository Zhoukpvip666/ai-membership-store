import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Prisma } from '../backend/src/generated/prisma/client.ts'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  hashPassword,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const ordersPath = '/account/orders'
const customerApi = '/api/v1/customer/orders'
const password = 'FictionalT21BrowserPassword123!'
const guidanceText =
  '线下转账请核对订单号\n<img src=x onerror="document.title=123">'
const paymentReminder =
  '请在微信付款页面填写正确的付款金额和商城订单号，避免无法核实到账。'
const manualUrl = 'https://example.test/manual?version=2#start'
const frozenDescription =
  '安装指南：' + manualUrl + '。\n遇到问题时请联系商家。'
const merchantRemark = '客服：测试商家\n咨询时间：周一至周五'
const schema = {
  version: 1,
  fields: [
    { id: 'account', type: 'text', label: '冻结账号', required: true },
    { id: 'optional', type: 'textarea', label: '冻结附言', required: false },
  ],
}
test.setTimeout(120_000)
test.afterAll(() => db.$disconnect())
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
})
async function cookie(context: BrowserContext, userId: string) {
  const raw = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: raw,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
}

async function setup(context: BrowserContext, login = false) {
  const marker = randomUUID().slice(0, 8)
  const [user, other, admin, product] = await Promise.all([
    db.user.create({
      data: {
        loginEmail: marker + '@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        ...(login ? { passwordHash: await hashPassword(password) } : {}),
      },
    }),
    db.user.create({
      data: {
        loginEmail: 'other-' + marker + '@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    }),
    db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
    db.product.create({
      data: {
        slug: randomUUID(),
        name: '现行商品 ' + marker,
        type: 'ONE_TIME',
        priceFen: 2000,
        termLabel: '现行商品周期',
        formSchema: {
          version: 1,
          fields: [
            { id: 'new', type: 'text', label: '现行表单', required: true },
          ],
        },
      },
    }),
  ])
  if (!login) await cookie(context, user.id)
  const createOrder = (extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    db.order.create({
      data: {
        orderNo: 'T21-' + randomUUID().replaceAll('-', ''),
        source: 'ADMIN',
        createdByAdminId: admin.id,
        userId: user.id,
        productId: product.id,
        kind: 'ONE_TIME',
        productNameSnapshot: '冻结商品 ' + marker,
        productTypeSnapshot: 'ONE_TIME',
        productDescriptionSnapshot: '冻结商品说明',
        priceSnapshotFen: 1500,
        termSnapshot: '原始周期说明',
        amountFen: 1000,
        contactEmailSnapshot: 'frozen-contact@example.com',
        formSchemaSnapshot: schema,
        formData: { account: '原始登录标识', optional: '需要清除' },
        targetIdentifier: 'legacy-not-a-display-field',
        internalNote: '仅管理员可见的订单备注',
        ...extra,
      },
    })
  return { user, other, admin, product, createOrder }
}
function row(page: Page, orderNo: string) {
  return page.locator('.customer-order-card').filter({ hasText: orderNo })
}
async function open(page: Page, orderNo: string) {
  await row(page, orderNo)
    .getByRole('button', { name: '查看详情', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '订单详情', exact: true })
  await expect(dialog).toContainText(orderNo)
  return dialog
}
async function captureOrderDetail(page: Page, project: string, name: string) {
  const output = process.env.ORDER_DETAIL_EVIDENCE_DIR
  if (!output) return
  await expect(page.locator('.el-message')).toHaveCount(0)
  await mkdir(output, { recursive: true })
  await page.screenshot({
    path: join(output, project + '-' + name + '.png'),
    animations: 'disabled',
    scale: 'css',
  })
}

const mutationHeaders = () => ({
  origin: env.APP_BASE_URL,
  'x-requested-with': 'MembershipStore',
  'Idempotency-Key': randomUUID(),
})

test('numeric order numbers group and copy raw digits while legacy numbers still search and copy', async ({
  page,
  context,
}) => {
  const { admin, createOrder } = await setup(context)
  await createOrder({ orderNo: '583024917' })
  await createOrder({ orderNo: 'T24-LEGACY-12345' })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text: string) {
          document.body.dataset.copiedOrderNo = text
        },
      },
    })
  })
  for (const [display, raw] of [
    ['583 024 917', '583024917'],
    ['T24-LEGACY-12345', 'T24-LEGACY-12345'],
  ]) {
    await page.goto(ordersPath)
    await page.getByLabel('搜索订单').fill(display)
    await page.getByRole('button', { name: '查询订单', exact: true }).click()
    await expect(page.locator('.customer-order-card')).toHaveCount(1)
    await expect(row(page, display)).toBeVisible()
    const dialog = await open(page, display)
    await dialog
      .getByRole('region', { name: '订单号', exact: true })
      .getByRole('button', { name: '复制订单号' })
      .click()
    await expect(page.locator('body')).toHaveAttribute(
      'data-copied-order-no',
      raw,
    )
  }
  await cookie(context, admin.id)
  await page.goto('/admin/orders')
  await page
    .getByRole('textbox', { name: '搜索订单', exact: true })
    .fill('583 024 917')
  await page.getByRole('button', { name: '查询订单', exact: true }).click()
  const adminRow = page.locator('tbody tr').filter({ hasText: '583 024 917' })
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await adminRow.getByRole('button', { name: '查看详情' }).click()
  const adminDetail = page.getByRole('dialog', {
    name: '订单详情',
    exact: true,
  })
  await expect(adminDetail).toContainText('583 024 917')
  const copy = adminDetail.getByRole('button', { name: '复制订单号' })
  await copy.click()
  await expect(page.locator('body')).toHaveAttribute(
    'data-copied-order-no',
    '583024917',
  )
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined })
  })
  await copy.click()
  await expect(adminDetail.getByLabel('原始订单号')).toHaveValue('583024917')
})

test('customer login and real paginated, searchable own orders with recoverable failure', async ({
  page,
  context,
}) => {
  const { user, other, createOrder } = await setup(context, true)
  const own = await createOrder({
    orderNo: 'OWN-' + randomUUID().replaceAll('-', ''),
    createdAt: new Date(Date.now() - 5000),
  })
  await db.$transaction(Array.from({ length: 20 }, () => createOrder()))
  const foreign = await createOrder({ userId: other.id })
  await page.goto(ordersPath)
  await expect(page).toHaveURL(/\/login\?/)
  await page.getByLabel('登录邮箱', { exact: true }).fill(user.loginEmail)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(ordersPath)
  await expect(page.getByText('共 21 笔订单')).toBeVisible()
  await expect(page.locator('.customer-order-card')).toHaveCount(20)
  await page.getByRole('button', { name: 'Go to next page' }).click()
  await expect(page.locator('.customer-order-card')).toHaveCount(1)
  await expect(row(page, own.orderNo)).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)

  const queries: string[] = []
  await page.route('**/api/v1/customer/orders?*', (route) => {
    queries.push(route.request().url())
    return queries.length === 1
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } })
      : route.continue()
  })
  await page.getByLabel('搜索订单').fill(own.orderNo.slice(0, 10))
  await page.getByLabel('订单类型', { exact: true }).selectOption('ONE_TIME')
  await page.getByRole('button', { name: '待付款', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法读取订单')
  await page.getByRole('button', { name: '重试订单' }).click()
  await expect(page.getByText('共 1 笔订单')).toBeVisible()
  const query = new URL(queries.at(-1)!).searchParams
  expect(Object.fromEntries(query)).toMatchObject({
    search: own.orderNo.slice(0, 10),
    paymentStatus: 'UNPAID',
    kind: 'ONE_TIME',
    page: '1',
  })

  await page.getByLabel('搜索订单').fill(foreign.orderNo)
  await page.getByRole('button', { name: '查询订单' }).click()
  await expect(page.getByText('暂无符合条件的订单')).toBeVisible()
  for (const id of [foreign.id, randomUUID()]) {
    const response = await page.request.get(customerApi + '/' + id)
    expect(response.status()).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  }
  for (const path of [
    '/admin/settings',
    '/admin/orders',
    '/admin/orders/' + own.id + '/payment-transactions',
    '/admin/orders/' + own.id + '/refunds',
  ])
    expect((await page.request.get('/api/v1' + path)).status()).toBe(403)
  await page.goto('/admin/orders')
  await expect(page).toHaveURL('/profile')
  await page.goto('/admin/settings')
  await expect(page).toHaveURL('/profile')
})

test('admin saves and clears the plain-text merchant remark without rendering markup', async ({
  browser,
  page,
  context,
}, info) => {
  const { admin, createOrder } = await setup(context)
  const order = await createOrder()
  const settings = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  const adminContext = await browser.newContext({ baseURL: env.APP_BASE_URL })
  try {
    await cookie(adminContext, admin.id)
    const adminPage = await adminContext.newPage()
    await adminPage.goto('/admin/settings')
    const instructions = adminPage.getByLabel('商家备注', { exact: true })
    await expect(instructions).toBeEnabled()
    await expect(instructions).toHaveAttribute('maxlength', '4000')
    await adminPage
      .getByLabel('业务时区', { exact: true })
      .fill('America/Los_Angeles')
    await instructions.fill(guidanceText)
    const save = async () => {
      const [response] = await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().endsWith('/api/v1/admin/settings') &&
            res.request().method() === 'PATCH',
        ),
        adminPage.getByRole('button', { name: '保存设置' }).click(),
      ])
      expect(response.status()).toBe(200)
    }
    await save()

    await page.goto(ordersPath)
    const detail = await open(page, order.orderNo)
    const panel = detail.getByRole('region', { name: '商家备注' })
    await expect(panel.locator('p').first()).toHaveText(paymentReminder)
    await expect(panel.locator('.merchant-text')).toHaveJSProperty(
      'textContent',
      guidanceText,
    )
    await expect(panel).toContainText('线下转账请核对订单号')
    await expect(panel).toContainText(
      '<img src=x onerror="document.title=123">',
    )
    await expect(panel.locator('img')).toHaveCount(0)
    await expect(detail.locator('.customer-countdown')).toHaveText(
      /\d{2}:\d{2}:\d{2}/,
    )
    await expect(detail).toContainText('冻结商品说明')
    await expect(detail).toContainText('frozen-contact@example.com')
    await expect(detail).toContainText('原始周期说明')
    await expect(detail).toContainText('¥15.00')
    await expect(detail).toContainText('冻结账号')
    await expect(detail).not.toContainText('现行表单')
    await expect(detail).not.toContainText('legacy-not-a-display-field')
    await expect(detail).not.toContainText('仅管理员可见的订单备注')
    await expect(detail).not.toContainText(env.ADMIN_EMAIL)
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'America/Los_Angeles',
      dateStyle: 'short',
      timeStyle: 'medium',
      hour12: false,
    }).format(order.createdAt)
    await expect(
      detail.getByRole('region', { name: '订单进度' }),
    ).toContainText(formatted)
    const isMobile = info.project.name === 'mobile-edge'
    const dialogPanel = detail.locator('.el-dialog')
    await expect(detail.locator('.el-dialog.is-fullscreen')).toHaveCount(
      isMobile ? 1 : 0,
    )
    if (isMobile)
      expect(Math.round((await dialogPanel.boundingBox())!.width)).toBe(
        page.viewportSize()!.width,
      )
    await instructions.fill('')
    await save()
    await page.reload()
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('orderId') === order.id,
    )
    await expect(detail).toContainText(order.orderNo)
    await expect(
      detail.getByRole('region', { name: '微信扫码付款' }),
    ).toContainText('商家暂未开放扫码收款，请联系商家')
    await expect(panel.locator('p')).toHaveCount(1)
    await expect(panel.locator('p')).toHaveText(paymentReminder)
    const payment = detail.getByRole('region', { name: '微信扫码付款' })
    await expect(payment).not.toContainText('填写正确')
    await expect(payment.getByRole('img')).toHaveCount(0)
    await expect(
      payment.getByRole('button', { name: '我已付款' }),
    ).toBeEnabled()

    const guidancePath = '/api/v1/customer/order-guidance'
    const isGuidance = (url: URL) => url.pathname === guidancePath
    await page.route(isGuidance, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE' } },
      }),
    )
    await page.reload()
    await expect(panel.getByRole('alert')).toContainText('商家备注暂不可用')
    await expect(panel.locator('p').first()).toHaveText(paymentReminder)
    await page.unroute(isGuidance)
    const [retryResponse] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === guidancePath,
      ),
      panel.getByRole('button', { name: '重试读取' }).click(),
    ])
    expect(retryResponse.ok()).toBe(true)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.locator('p')).toHaveText(paymentReminder)
  } finally {
    await adminContext.close()
    await db.appSettings.update({
      where: { id: 1 },
      data: {
        timezone: settings.timezone,
        paymentInstructions: settings.paymentInstructions,
      },
    })
  }
})

test('customer downloads QR, retries a lost claim, and sees real admin verification', async ({
  browser,
  page,
  context,
}, info) => {
  const { admin, createOrder } = await setup(context)
  const order = await createOrder({
    orderNo: '583024919',
    productDescriptionSnapshot: frozenDescription,
    createdAt: new Date(Date.now() - 60_000),
  })
  const saved = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  const adminContext = await browser.newContext({ baseURL: env.APP_BASE_URL })
  try {
    await cookie(adminContext, admin.id)
    const adminPage = await adminContext.newPage()
    // A QR for the reserved example.test domain. It carries no payment details.
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAJQAAACUAQAAAABdRz15AAABPklEQVR4nO1WQW4EMQgz0dzND/L/Z80PzAtckblt1aoVe1zmgiLFIsaGCeM1an07Aj5n+ImDiEhEJupJMeSKNiAo+aSY4F0AgigilOp0jgeAWc7K/91dv50Zot6DZyGrv5PO8MIIoFnrKIAa+ePqlwKVQoKP+dasvryxq0u8n0JrggdbltQKpCnTGuIR7O5Cp8Ge4Z3+Qqn0xv00Zs3qs9lOa7FQmr/XpGyBOuBv4E+UQTWNGNZ3AUWqwgWo1AyuGZ4rGgrZYDX3bx3tYZOI4nye7uRuDfbY2tP6LkB5E4lS9lid64/tDVstQXKulw7IbK20sDXkLyKyN5KMRE+GNcOjz0zNnVDtd/BHHrc9Lx77o2M3FGpX+C37su1xgwqmxnju1VHqXe5W4Br6LQJRWRLayeN99Br1+XfEn/X8BYBYuWuykyJBAAAAAElFTkSuQmCC',
      'base64',
    )
    expect(
      (
        await adminPage.request.put('/api/v1/admin/settings/wechat-qr', {
          data: image,
          headers: {
            ...mutationHeaders(),
            'Content-Type': 'application/octet-stream',
          },
        })
      ).status(),
    ).toBe(200)
    expect(
      (
        await adminPage.request.patch('/api/v1/admin/settings/wechat-payment', {
          data: { enabled: true },
          headers: mutationHeaders(),
        })
      ).status(),
    ).toBe(200)
    expect(
      (
        await adminPage.request.patch('/api/v1/admin/settings', {
          data: { paymentInstructions: merchantRemark },
          headers: mutationHeaders(),
        })
      ).status(),
    ).toBe(200)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          async writeText(text: string) {
            document.body.dataset.copiedOrderNo = text
          },
        },
      })
    })
    await page.goto(ordersPath)
    const detail = await open(page, '583 024 919')
    const panel = detail.getByRole('region', { name: '微信扫码付款' })
    await expect(panel).toContainText('¥10.00')
    await expect(panel).toContainText('583 024 919')
    await expect(
      panel.getByRole('img', { name: '微信收款二维码' }),
    ).toBeVisible()
    await expect(detail.locator('.customer-countdown')).toBeVisible()
    const reference = detail.getByRole('region', {
      name: '订单号',
      exact: true,
    })
    await expect(reference).toContainText('583 024 919')
    await reference.getByRole('button', { name: '复制订单号' }).click()
    await expect(page.locator('body')).toHaveAttribute(
      'data-copied-order-no',
      order.orderNo,
    )
    await page
      .locator('body')
      .evaluate((element) => element.removeAttribute('data-copied-order-no'))
    await panel.getByRole('button', { name: '复制订单号' }).click()
    await expect(page.locator('body')).toHaveAttribute(
      'data-copied-order-no',
      order.orderNo,
    )
    const remarks = detail.getByRole('region', { name: '商家备注' })
    await expect(remarks.locator('p').first()).toHaveText(paymentReminder)
    await expect(remarks.locator('.merchant-text')).toHaveJSProperty(
      'textContent',
      merchantRemark,
    )
    await expect(panel).not.toContainText('填写正确')
    const qrArea = (await panel.locator('.payment-code').boundingBox())!
    const summary = (await panel.locator('.payment-summary').boundingBox())!
    const mobile = info.project.name === 'mobile-edge'
    if (mobile) {
      expect(qrArea.y + qrArea.height).toBeLessThan(summary.y)
      expect(Math.abs(qrArea.x - summary.x)).toBeLessThanOrEqual(1)
    } else {
      expect(qrArea.x + qrArea.width).toBeLessThan(summary.x)
    }
    expect(
      await detail
        .locator('.el-dialog')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await detail
      .getByRole('heading', { name: order.productNameSnapshot })
      .scrollIntoViewIfNeeded()
    await captureOrderDetail(page, info.project.name, 'awaiting-payment')
    if (mobile && process.env.ORDER_DETAIL_EVIDENCE_DIR) {
      await panel.evaluate((element) =>
        element.scrollIntoView({ block: 'start' }),
      )
      await captureOrderDetail(page, info.project.name, 'payment-panel')
    }
    const description = detail.getByRole('region', { name: '商品及价格' })
    await expect(description.locator('.linked-text')).toHaveJSProperty(
      'textContent',
      frozenDescription,
    )
    await expect(
      description.getByRole('link', { name: manualUrl, exact: true }),
    ).toBeVisible()
    await remarks.evaluate((element) =>
      element.scrollIntoView({ block: 'start' }),
    )
    await captureOrderDetail(page, info.project.name, 'remarks-and-links')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('link', { name: '保存二维码' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('wechat-payment-qr.png')
    expect(await download.failure()).toBeNull()
    const claimPath = customerApi + '/' + order.id + '/payment-claim'
    const posted: { key: string; body: unknown }[] = []
    await page.route(
      (url) => url.pathname === claimPath,
      async (route) => {
        posted.push({
          key: route.request().headers()['idempotency-key']!,
          body: route.request().postDataJSON(),
        })
        if (posted.length === 1) {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          return route.abort('failed')
        }
        return route.continue()
      },
    )
    await panel.getByRole('button', { name: '我已付款' }).click()
    const confirm = page.getByRole('dialog', { name: '确认付款核实' })
    await expect(confirm).toContainText(
      '请确认你已在微信完成付款，且付款金额和填写的商城订单号均正确。',
    )
    await confirm.getByRole('button', { name: '提交付款核实' }).click()
    await expect(confirm.getByRole('status')).toContainText('结果尚未确认')
    await confirm.getByRole('button', { name: '重试原请求' }).click()
    await expect(detail).toContainText('已提交付款核实，请勿重复转账。')
    await expect(detail).toContainText('24 小时未核实可能自动取消')
    await expect(reference).toContainText('583 024 919')
    await expect(remarks).not.toContainText(paymentReminder)
    await expect(panel).toHaveCount(0)
    await expect(detail.getByRole('button', { name: '我已付款' })).toHaveCount(
      0,
    )
    expect(posted).toHaveLength(2)
    expect(posted[0].body).toEqual({ expectedVersion: 1 })
    expect(posted[0].key).toBeTruthy()
    expect(posted[1]).toEqual(posted[0])
    expect(
      await db.paymentTransaction.count({ where: { orderId: order.id } }),
    ).toBe(0)
    expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(
      1,
    )
    expect(
      await db.subscription.count({ where: { sourceOrderId: order.id } }),
    ).toBe(0)

    await adminPage.goto('/admin/orders')
    await adminPage
      .getByRole('button', { name: '待核实付款', exact: true })
      .click()
    const adminRow = adminPage
      .locator('tbody tr')
      .filter({ hasText: '583 024 919' })
    await expect(adminRow).toBeVisible()
    const registered = await adminPage.request.post(
      '/api/v1/admin/orders/' + order.id + '/payment-transactions',
      {
        headers: mutationHeaders(),
        data: {
          expectedVersion: 2,
          amountFen: order.amountFen,
          channel: 'WECHAT',
          occurredAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    )
    expect(registered.status()).toBe(201)
    const { paymentTransaction } = await registered.json()
    const verified = await adminPage.request.post(
      '/api/v1/admin/payment-transactions/' +
        paymentTransaction.id +
        '/confirm',
      { headers: mutationHeaders(), data: { expectedVersion: 3 } },
    )
    expect(verified.status()).toBe(200)
    await page.reload()
    await expect(detail).toContainText('付款 · 已付款')
    await expect(
      detail.getByRole('region', { name: '商家备注' }),
    ).toContainText('客服：测试商家')
    await expect(reference).toContainText('583 024 919')
    await expect(remarks).not.toContainText(paymentReminder)
    await expect(panel).toHaveCount(0)
    expect(
      await db.subscription.count({ where: { sourceOrderId: order.id } }),
    ).toBe(0)
  } finally {
    await adminContext.close()
    await db.appSettings.update({
      where: { id: 1 },
      data: {
        paymentInstructions: saved.paymentInstructions,
        wechatPayEnabled: saved.wechatPayEnabled,
        wechatQrImageKey: saved.wechatQrImageKey,
      },
    })
  }
})

test('status presets and lifecycle timestamps show only customer-safe order facts', async ({
  page,
  context,
}, info) => {
  const { createOrder } = await setup(context)
  const createdAt = new Date(Date.now() - 60_000)
  const paidAt = new Date(Date.now() - 3000)
  const paymentConfirmedAt = new Date(Date.now() - 2000)
  const cancelledAt = new Date(Date.now() - 1000)
  const [pending, zero, paid, complete, cancelled, waitRefund, refunded] =
    await Promise.all([
      createOrder({ createdAt, paymentStatus: 'PENDING_VERIFICATION' }),
      createOrder({
        createdAt,
        amountFen: 0,
        paymentStatus: 'NOT_REQUIRED',
        fulfillmentStatus: 'PROCESSING',
      }),
      createOrder({
        createdAt,
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
        paidAt,
        paymentConfirmedAt,
      }),
      createOrder({
        createdAt,
        paymentStatus: 'PAID',
        fulfillmentStatus: 'COMPLETED',
        paidAt,
        paymentConfirmedAt,
        fulfilledAt: cancelledAt,
      }),
      createOrder({ createdAt, fulfillmentStatus: 'CANCELLED', cancelledAt }),
      createOrder({
        createdAt,
        paymentStatus: 'REFUND_PENDING',
        fulfillmentStatus: 'CANCELLED',
        paidAt,
        paymentConfirmedAt,
        cancelledAt,
        cancellationReason: '专用内部取消原因',
      }),
      createOrder({
        createdAt,
        paymentStatus: 'REFUNDED',
        fulfillmentStatus: 'CANCELLED',
        paidAt,
        paymentConfirmedAt,
        cancelledAt,
      }),
    ])
  await page.goto(ordersPath)
  const close = async () =>
    page
      .getByRole('dialog', { name: '订单详情' })
      .getByRole('button', { name: 'Close this dialog' })
      .click()
  for (const [order, label] of [
    [pending, '付款待核实'],
    [zero, '处理中'],
    [paid, '处理中'],
    [complete, '已完成'],
    [cancelled, '已取消'],
    [waitRefund, '待退款'],
    [refunded, '已退款'],
  ] as const)
    await expect(
      row(page, order.orderNo).locator('.customer-order-status'),
    ).toHaveText(label)
  for (const order of [
    pending,
    paid,
    zero,
    complete,
    cancelled,
    waitRefund,
    refunded,
  ]) {
    const detail = await open(page, order.orderNo)
    const reference = detail.getByRole('region', {
      name: '订单号',
      exact: true,
    })
    await expect(reference).toContainText(order.orderNo)
    await expect(
      reference.getByRole('button', { name: '复制订单号' }),
    ).toBeVisible()
    await expect(detail.getByRole('button', { name: '取消订单' })).toHaveCount(
      order.id === pending.id ? 1 : 0,
    )
    await expect(detail.getByRole('button', { name: '修改订单' })).toHaveCount(
      0,
    )
    await expect(
      detail.getByRole('region', { name: '微信扫码付款' }),
    ).toHaveCount(0)
    await expect(detail.getByRole('region', { name: '商家备注' })).toHaveCount(
      0,
    )
    await expect(detail).not.toContainText(paymentReminder)
    if (order.id === complete.id) {
      await expect(detail.locator('.order-state')).toHaveText('已完成')
      await captureOrderDetail(page, info.project.name, 'completed')
    }
    await close()
  }
  await page.getByRole('button', { name: '处理中', exact: true }).click()
  await expect(page.locator('.customer-order-card')).toHaveCount(2)
  await page.getByRole('button', { name: '已取消', exact: true }).click()
  await expect(page.locator('.customer-order-card')).toHaveCount(3)
  await page.getByRole('button', { name: '待退款', exact: true }).click()
  await expect(page.locator('.customer-order-card')).toHaveCount(1)
  const refundDetail = await open(page, waitRefund.orderNo)
  const timeline = refundDetail.getByRole('region', { name: '订单进度' })
  await expect(timeline.locator('li')).toHaveCount(4)
  await expect(timeline).toContainText('商家确认收款')
  await expect(timeline).not.toContainText('退款')
  await expect(refundDetail).not.toContainText('专用内部取消原因')
  await expect(refundDetail).not.toContainText('退款处理中')
  await expect(
    refundDetail.getByRole('region', { name: '微信扫码付款' }),
  ).toHaveCount(0)
})

test('frozen-form edit handles stale version and replays the exact request after a lost response', async ({
  page,
  context,
}) => {
  const { createOrder } = await setup(context)
  const original = await createOrder()
  await page.goto(ordersPath)
  const detail = await open(page, original.orderNo)
  await detail.getByRole('button', { name: '修改订单', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '修改订单', exact: true })
  const endpoint = customerApi + '/' + original.id
  const racing = await page.request.patch(endpoint, {
    headers: mutationHeaders(),
    data: {
      expectedVersion: 1,
      formData: { account: '并发更新', optional: '保留到下一次提交' },
    },
  })
  expect(racing.status()).toBe(200)
  await edit.getByLabel('服务信息 冻结账号').fill('旧页面修改')
  await edit.getByRole('button', { name: '保存修改' }).click()
  await expect(
    detail.getByRole('status').filter({ hasText: '版本已变化' }),
  ).toBeVisible()
  await expect(detail).toContainText('并发更新')
  await detail.getByRole('button', { name: '修改订单', exact: true }).click()
  await edit.getByLabel('服务信息 冻结账号').fill('明确保存')
  await edit.getByLabel('服务信息 冻结附言').fill('')
  const attempts: { key: string | undefined; body: string | null }[] = []
  await page.route('**' + endpoint, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    })
    if (attempts.length === 1) {
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      await route.abort()
    } else await route.continue()
  })
  await edit.getByRole('button', { name: '保存修改' }).click()
  await expect(edit.getByRole('button', { name: '重试原请求' })).toBeVisible()
  await expect(edit.getByLabel('服务信息 冻结账号')).toBeDisabled()
  await edit.getByRole('button', { name: '重试原请求' }).click()
  await expect(detail).toContainText('明确保存')
  expect(attempts).toHaveLength(2)
  expect(attempts[0]?.key).toBeTruthy()
  expect(attempts[1]).toEqual(attempts[0])
  expect(JSON.parse(attempts[0]!.body!)).toEqual({
    expectedVersion: 2,
    formData: { account: '明确保存' },
  })
  const persisted = await db.order.findUniqueOrThrow({
    where: { id: original.id },
  })
  expect(persisted.version).toBe(3)
  expect(persisted.amountFen).toBe(original.amountFen)
  expect(persisted.formData).toEqual({ account: '明确保存' })
  expect(
    await db.orderEvent.count({
      where: { orderId: original.id, actorType: 'USER' },
    }),
  ).toBe(2)
  expect(
    await db.adminAuditLog.count({ where: { entityId: original.id } }),
  ).toBe(0)
})

test('customer must confirm pending-verification cancellation and closes only unconfirmed attempts', async ({
  page,
  context,
}) => {
  const { admin, createOrder } = await setup(context)
  const unpaid = await createOrder()
  const pending = await createOrder({ paymentStatus: 'PENDING_VERIFICATION' })
  const attempt = await db.paymentTransaction.create({
    data: {
      orderId: pending.id,
      kind: 'PAYMENT',
      amountFen: pending.amountFen,
      channel: 'CASH',
      status: 'PENDING',
      occurredAt: new Date(),
      createdByAdminId: admin.id,
      externalReference: 'PAYMENT-EVIDENCE-PROHIBITED-IN-UI',
    },
  })
  await page.goto(ordersPath)
  for (const order of [unpaid, pending]) {
    const detail = await open(page, order.orderNo)
    if (order.id === pending.id) {
      await expect(detail).toContainText(
        '已提交付款核实，请勿重复转账。管理员确认实际到账后才会处理订单。',
      )
      await expect(detail).not.toContainText(attempt.externalReference!)
      await expect(
        detail.getByRole('region', { name: '微信扫码付款' }),
      ).toHaveCount(0)
    }
    await detail.getByRole('button', { name: '取消订单', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '确认取消订单' })
    await expect(confirm).toContainText('取消后无法恢复此订单')
    if (order.id === pending.id)
      await expect(confirm).toContainText('取消会关闭待核实付款记录')
    await confirm.getByRole('button', { name: '确认取消', exact: true }).click()
    await expect(
      detail.getByRole('status').filter({ hasText: '订单已取消' }),
    ).toBeVisible()
    await expect(detail.getByRole('button', { name: '取消订单' })).toHaveCount(
      0,
    )
    await detail.getByRole('button', { name: 'Close this dialog' }).click()
    await expect(
      row(page, order.orderNo).locator('.customer-order-status'),
    ).toHaveText('已取消')
  }
  expect(
    (
      await db.paymentTransaction.findUniqueOrThrow({
        where: { id: attempt.id },
      })
    ).status,
  ).toBe('FAILED')
})

for (const view of ['list', 'detail'] as const) {
  test(`${view} countdown starts when a delayed real order response arrives`, async ({
    page,
    context,
  }) => {
    const { createOrder } = await setup(context)
    const order = await createOrder()
    const path = view === 'list' ? customerApi : customerApi + '/' + order.id
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        const response = await route.fetch()
        await delay(2750)
        await route.fulfill({ response })
      },
    )
    if (view === 'detail') await page.goto(ordersPath)

    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === path,
      ),
      view === 'list' ? page.goto(ordersPath) : open(page, order.orderNo),
    ])
    expect(response.ok()).toBe(true)
    const payload = await response.json()
    const dto =
      view === 'list'
        ? payload.items.find((item: { id: string }) => item.id === order.id)
        : payload.order
    const supplied: number = dto.remainingSeconds
    expect(supplied).toBeGreaterThan(0)

    const scope =
      view === 'list'
        ? row(page, order.orderNo)
        : page.getByRole('dialog', { name: '订单详情', exact: true })
    const timer = scope.locator('.customer-countdown')
    await expect(timer).toBeVisible()
    async function displayedSeconds() {
      const match = (await timer.innerText()).match(/(\d{2}):(\d{2}):(\d{2})/)
      expect(match).not.toBeNull()
      return (
        Number(match![1]) * 3600 + Number(match![2]) * 60 + Number(match![3])
      )
    }
    const first = await displayedSeconds()
    // The first browser tick may occur before this assertion. Even then, the
    // 2.75 seconds for which the response was held must not be debited.
    expect(supplied - first).toBeGreaterThanOrEqual(0)
    expect(supplied - first).toBeLessThanOrEqual(1)
    await expect.poll(displayedSeconds).toBeLessThan(first)
  })
}

test('valid empty dynamic form keeps order details and cancellation without an edit action', async ({
  page,
  context,
}) => {
  const { createOrder } = await setup(context)
  const empty = { version: 1, fields: [] }
  const order = await createOrder({
    formSchemaSnapshot: empty,
    formData: {},
  })
  await page.goto(ordersPath)
  const [response, detail] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === customerApi + '/' + order.id,
    ),
    open(page, order.orderNo),
  ])
  expect(response.ok()).toBe(true)
  expect((await response.json()).order).toMatchObject({
    formSchemaSnapshot: empty,
    formData: {},
  })
  await expect(
    detail.getByRole('heading', { name: order.productNameSnapshot }),
  ).toBeVisible()
  await expect(detail).toContainText('冻结商品说明')
  await expect(detail).toContainText('¥10.00')
  await expect(
    detail.getByRole('region', { name: '微信扫码付款' }),
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: '修改订单', exact: true }),
  ).toHaveCount(0)
  await expect(
    detail.getByRole('button', { name: '取消订单', exact: true }),
  ).toBeVisible()
})

test('product descriptions link safely and both order details use the frozen description', async ({
  browser,
  page,
  context,
}) => {
  const { admin, createOrder, product } = await setup(context)
  const order = await createOrder({
    productDescriptionSnapshot: frozenDescription,
  })
  const currentUrl = 'http://example.test/current'
  const currentDescription = '商品说明：' + currentUrl + '。\n保留这一行。'
  await db.product.update({
    where: { id: product.id },
    data: { description: currentDescription, listed: true },
  })

  async function checkLinkedText(
    pageOrDialog: Page | ReturnType<Page['getByRole']>,
    url: string,
    text: string,
  ) {
    const link = pageOrDialog.getByRole('link', { name: url, exact: true })
    await expect(link).toHaveAttribute('href', url)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(link.locator('..')).toHaveJSProperty('textContent', text)
    return link
  }

  await page.goto('/products/' + product.slug)
  await checkLinkedText(page, currentUrl, currentDescription)
  await page.goto('/purchase/' + product.slug)
  await checkLinkedText(page, currentUrl, currentDescription)

  await page.goto(ordersPath)
  const detail = await open(page, order.orderNo)
  const link = await checkLinkedText(detail, manualUrl, frozenDescription)
  await expect(detail.getByRole('link', { name: currentUrl })).toHaveCount(0)
  await context.route(
    (url) =>
      url.origin === 'https://example.test' &&
      url.pathname === '/manual' &&
      url.search === '?version=2',
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>Test manual</title>',
      }),
  )
  const [opened] = await Promise.all([
    context.waitForEvent('page'),
    link.click(),
  ])
  await expect(opened).toHaveURL(manualUrl)
  await expect(opened).toHaveTitle('Test manual')
  expect(await opened.evaluate(() => window.opener)).toBeNull()
  await opened.close()

  const adminContext = await browser.newContext({ baseURL: env.APP_BASE_URL })
  try {
    await cookie(adminContext, admin.id)
    const adminPage = await adminContext.newPage()
    await adminPage.goto('/admin/orders')
    await adminPage
      .getByRole('row')
      .filter({ hasText: order.orderNo })
      .getByRole('button', { name: '查看详情', exact: true })
      .click()
    const adminOrder = adminPage.getByRole('dialog', {
      name: '订单详情',
      exact: true,
    })
    await checkLinkedText(adminOrder, manualUrl, frozenDescription)
    await expect(
      adminOrder.getByRole('link', { name: currentUrl }),
    ).toHaveCount(0)

    await adminPage.goto('/admin/products')
    await adminPage
      .getByRole('row')
      .filter({ hasText: product.name })
      .getByRole('button', { name: '详情', exact: true })
      .click()
    await checkLinkedText(
      adminPage.getByRole('dialog', { name: '商品详情', exact: true }),
      currentUrl,
      currentDescription,
    )
  } finally {
    await adminContext.close()
  }
})
