import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
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
const mutationHeaders = () => ({
  origin: env.APP_BASE_URL,
  'x-requested-with': 'MembershipStore',
  'Idempotency-Key': randomUUID(),
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

test('admin saves and clears plain-text guidance, customer sees it only on eligible order', async ({
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
    const instructions = adminPage.getByLabel('线下付款说明', { exact: true })
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
    const panel = detail.getByRole('region', { name: '线下付款说明' })
    await expect(panel).toContainText('线下转账请核对订单号')
    await expect(panel).toContainText(
      '<img src=x onerror="document.title=123">',
    )
    await expect(panel.locator('img')).toHaveCount(0)
    await expect(panel).toContainText(/剩余 \d{2}:\d{2}:\d{2}/)
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
      detail.getByRole('region', {
        name: '线下付款说明',
      }),
    ).toContainText('商家暂未配置付款说明，请联系商家确认')
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

test('status presets and lifecycle timestamps show only customer-safe order facts', async ({
  page,
  context,
}) => {
  const { createOrder } = await setup(context)
  const paidAt = new Date(Date.now() - 3000)
  const paymentConfirmedAt = new Date(Date.now() - 2000)
  const cancelledAt = new Date(Date.now() - 1000)
  const [pending, zero, paid, complete, cancelled, waitRefund, refunded] =
    await Promise.all([
      createOrder({ paymentStatus: 'PENDING_VERIFICATION' }),
      createOrder({
        amountFen: 0,
        paymentStatus: 'NOT_REQUIRED',
        fulfillmentStatus: 'PROCESSING',
      }),
      createOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
        paidAt,
        paymentConfirmedAt,
      }),
      createOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'COMPLETED',
        paidAt,
        paymentConfirmedAt,
        fulfilledAt: cancelledAt,
      }),
      createOrder({ fulfillmentStatus: 'CANCELLED', cancelledAt }),
      createOrder({
        paymentStatus: 'REFUND_PENDING',
        fulfillmentStatus: 'CANCELLED',
        paidAt,
        paymentConfirmedAt,
        cancelledAt,
        cancellationReason: '专用内部取消原因',
      }),
      createOrder({
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
  await page.getByRole('button', { name: '处理中', exact: true }).click()
  await expect(page.locator('.customer-order-card')).toHaveCount(2)
  for (const order of [paid, zero]) {
    const detail = await open(page, order.orderNo)
    await expect(detail.getByRole('button', { name: '取消订单' })).toHaveCount(
      0,
    )
    await expect(
      detail.getByRole('region', { name: '线下付款说明' }),
    ).toHaveCount(0)
    await close()
  }
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
    refundDetail.getByRole('region', { name: '线下付款说明' }),
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
      await expect(detail).toContainText('付款待核实，请勿重复转账')
      await expect(detail).not.toContainText(attempt.externalReference!)
      await expect(
        detail.getByRole('region', { name: '线下付款说明' }),
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
    detail.getByRole('region', { name: '线下付款说明' }),
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: '修改订单', exact: true }),
  ).toHaveCount(0)
  await expect(
    detail.getByRole('button', { name: '取消订单', exact: true }),
  ).toBeVisible()
})
