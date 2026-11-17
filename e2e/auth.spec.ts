import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import { integrationEnvironment } from '../backend/test/integration/support.ts'

// Direct Playwright execution without the isolated runner must fail closed.
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const customerPassword = 'BrowserFixturePassword2468!'
test.afterAll(() => db.$disconnect())
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== env.APP_BASE_URL)
      throw new Error('Browser tests must not call external services.')
    if (
      url.pathname.startsWith('/api/') &&
      !/^\/api\/v1\/(?:auth\/(?:login|logout|me|activate)|admin\/(?:users(?:\/[^/]+(?:\/(?:invitations|status))?)?|invitations\/[^/]+\/revoke))$/.test(
        url.pathname,
      )
    )
      throw new Error('Out-of-scope business API call.')
  })
})
async function submitLogin(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/auth/login' &&
        response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ])
  expect(response.status()).toBe(200)
}
async function login(page: Page) {
  await page.goto('/admin/login')
  await page
    .getByRole('textbox', { name: '登录邮箱', exact: true })
    .fill(env.ADMIN_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(env.ADMIN_PASSWORD)
  await submitLogin(page)
  await expect(page).toHaveURL('/admin/users')
  await expect(
    page.getByRole('heading', { name: '用户管理', exact: true }),
  ).toBeVisible()
}
async function post(page: Page, path: string, body: unknown) {
  return page.request.post('/api/v1' + path, {
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
    },
    data: body,
  })
}
async function createCustomer(page: Page) {
  const email = randomUUID() + '@example.com'
  await page.getByRole('button', { name: '新增客户', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新增客户', exact: true })
  await expect(dialog.locator('input[type=password]')).toHaveCount(0)
  await dialog
    .getByRole('textbox', { name: '客户姓名', exact: true })
    .fill('浏览器测试客户')
  await dialog
    .getByRole('textbox', { name: '客户登录邮箱', exact: true })
    .fill(email)
  await dialog.getByRole('button', { name: '保存客户', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('textbox', { name: '搜索用户', exact: true }).fill(email)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr')).toContainText('待激活')
  return email
}
async function openDetail(page: Page) {
  await page
    .locator('tbody tr')
    .getByRole('button', { name: '查看详情', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '用户详情', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function activate(page: Page, url: string) {
  await page.goto(url)
  await expect(page).toHaveURL('/activate')
  await page.getByLabel('设置密码', { exact: true }).fill(customerPassword)
  await page.getByLabel('确认密码', { exact: true }).fill(customerPassword)
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/auth/activate' &&
        response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '激活账户', exact: true }).click(),
  ])
}

test('admin login, safe cookies, refresh and logout protect administration', async ({
  page,
  context,
}, info) => {
  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/admin\/login/)
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(401)
  await page
    .getByRole('textbox', { name: '登录邮箱', exact: true })
    .fill(env.ADMIN_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(customerPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('邮箱或密码错误')
  await page.screenshot({
    path: 'test-results/login-' + info.project.name + '.png',
    fullPage: true,
  })
  await login(page)
  const cookie = (await context.cookies()).find(
    (item) => item.name === 'membership_session',
  )
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite).toBe('Strict')
  expect(
    await page.evaluate(() => document.cookie.includes('membership_session')),
  ).toBe(false)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '用户管理', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL('/admin/login')
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/admin\/login/)
})

test('real customers persist pending; duplicate email, editing, disabling and restoring work', async ({
  page,
}, info) => {
  await login(page)
  const email = await createCustomer(page)
  await page.getByRole('button', { name: '新增客户', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新增客户', exact: true })
  await create
    .getByRole('textbox', { name: '客户姓名', exact: true })
    .fill('重复邮箱')
  await create
    .getByRole('textbox', { name: '客户登录邮箱', exact: true })
    .fill(email.toUpperCase())
  await create.getByRole('button', { name: '保存客户', exact: true }).click()
  await expect(create.getByRole('alert')).toContainText('登录邮箱已被使用')
  await create.getByRole('button', { name: 'Close this dialog' }).click()
  await page
    .locator('tbody tr')
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  const edit = page.getByRole('dialog', { name: '编辑客户', exact: true })
  await expect(
    edit.getByRole('textbox', { name: '客户登录邮箱', exact: true }),
  ).toBeDisabled()
  await edit
    .getByRole('textbox', { name: '客户姓名', exact: true })
    .fill('已编辑客户')
  await edit
    .getByRole('textbox', { name: '客户通知邮箱', exact: true })
    .fill('notice@example.com')
  await edit.getByRole('button', { name: '保存客户', exact: true }).click()
  await expect(edit).not.toBeVisible()
  await expect(page.locator('tbody tr')).toContainText('已编辑客户')
  for (const action of ['停用', '恢复']) {
    await page
      .locator('tbody tr')
      .getByRole('button', { name: action, exact: true })
      .click()
    const dialog = page.getByRole('dialog', {
      name: action + '客户',
      exact: true,
    })
    await dialog
      .getByRole('textbox', { name: '操作原因', exact: true })
      .fill('浏览器验收')
    await dialog
      .getByRole('button', { name: '确认更新状态', exact: true })
      .click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('tbody tr')).toContainText(
      action === '停用' ? '已停用' : '待激活',
    )
  }
  const detail = await openDetail(page)
  await expect(detail).toContainText('notice@example.com')
  await expect(detail).toContainText('尚未激活')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/customers-' + info.project.name + '.png',
    fullPage: true,
  })
  await page.reload()
  await page.getByRole('textbox', { name: '搜索用户', exact: true }).fill(email)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr')).toContainText('已编辑客户')
  const stored = await db.user.findUniqueOrThrow({
    where: { loginEmail: email },
  })
  expect(stored.status).toBe('PENDING_ACTIVATION')
  expect(stored.passwordHash).toBeNull()
})

test('invitation copying, one-time response, reissue, activation and customer isolation work', async ({
  page,
  browser,
}, info) => {
  // This flow intentionally includes three activation attempts and two browser contexts.
  test.setTimeout(60000)
  await login(page)
  const email = await createCustomer(page)
  let detail = await openDetail(page)
  await expect(detail).toContainText('只能在本机打开')
  await detail
    .getByRole('button', { name: '生成邀请链接', exact: true })
    .click()
  const input = detail.getByRole('textbox', {
    name: '本次邀请链接',
    exact: true,
  })
  await expect(input).toBeVisible()
  const oldUrl = await input.inputValue()
  // Stub only the OS clipboard boundary; verify the actual copied payload.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(
            window as unknown as { copiedInvitation: string }
          ).copiedInvitation = value
        },
      },
    }),
  )
  await detail
    .getByRole('button', { name: '复制邀请链接', exact: true })
    .click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { copiedInvitation: string }).copiedInvitation,
    ),
  ).toBe(oldUrl)
  await detail.getByRole('button', { name: 'Close this dialog' }).click()
  detail = await openDetail(page)
  await expect(
    detail.getByRole('textbox', { name: '本次邀请链接', exact: true }),
  ).toHaveCount(0)
  await detail
    .getByRole('button', { name: '重新生成邀请链接', exact: true })
    .click()
  await expect(
    detail.getByRole('textbox', { name: '本次邀请链接', exact: true }),
  ).toBeVisible()
  const currentUrl = await detail
    .getByRole('textbox', { name: '本次邀请链接', exact: true })
    .inputValue()
  expect(currentUrl).not.toBe(oldUrl)
  const customerContext = await browser.newContext({
    baseURL: env.APP_BASE_URL,
    viewport: info.project.use.viewport,
  })
  const customerPage = await customerContext.newPage()
  try {
    await activate(customerPage, oldUrl)
    await expect(customerPage.getByRole('alert')).toContainText('邀请无效')
    await activate(customerPage, currentUrl)
    await expect(
      customerPage.getByRole('heading', { name: '账户激活成功', exact: true }),
    ).toBeVisible()
    await activate(customerPage, currentUrl)
    await expect(customerPage.getByRole('alert')).toContainText('邀请无效')
    await customerPage.goto('/login')
    await customerPage
      .getByRole('textbox', { name: '登录邮箱', exact: true })
      .fill(email)
    await customerPage
      .getByLabel('密码', { exact: true })
      .fill(customerPassword)
    await submitLogin(customerPage)
    await expect(customerPage).toHaveURL('/profile')
    await expect(customerPage.locator('.profile-panel')).toContainText(email)
    expect(
      (await customerPage.request.get('/api/v1/admin/users')).status(),
    ).toBe(403)
    await customerPage.goto('/admin/users')
    await expect(customerPage).toHaveURL('/profile')
    for (const path of ['/orders', '/subscriptions']) {
      await customerPage.goto(path)
      await expect(
        customerPage.getByText(
          '真实' +
            (path === '/orders' ? '订单' : '订阅') +
            '历史将在后续任务接入',
          { exact: false },
        ),
      ).toBeVisible()
      await expect(
        customerPage.locator('tbody tr,.subscription-card'),
      ).toHaveCount(0)
    }
    await customerPage.goto('/profile')
    await customerPage
      .getByRole('button', { name: '退出登录', exact: true })
      .click()
    await expect(customerPage).toHaveURL('/login')
    expect((await customerPage.request.get('/api/v1/auth/me')).status()).toBe(
      401,
    )
  } finally {
    await customerContext.close()
  }
})

test('expired and explicitly revoked invitations fail on the activation page', async ({
  page,
  browser,
}) => {
  // Two separate activation contexts plus real database setup can exceed 30s in parallel.
  test.setTimeout(60000)
  await login(page)
  const email = await createCustomer(page)
  const user = await db.user.findUniqueOrThrow({ where: { loginEmail: email } })
  for (const state of ['expired', 'revoked']) {
    const response = await post(
      page,
      '/admin/users/' + user.id + '/invitations',
      {},
    )
    expect(response.status()).toBe(201)
    const invitation = await response.json()
    if (state === 'expired')
      await db.invitationToken.update({
        where: { id: invitation.invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
    else
      expect(
        (
          await post(
            page,
            '/admin/invitations/' + invitation.invitation.id + '/revoke',
            {},
          )
        ).status(),
      ).toBe(204)
    const context = await browser.newContext({ baseURL: env.APP_BASE_URL })
    try {
      const customerPage = await context.newPage()
      await activate(customerPage, invitation.url)
      await expect(customerPage.getByRole('alert')).toContainText('邀请无效')
    } finally {
      await context.close()
    }
  }
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).status,
  ).toBe('PENDING_ACTIVATION')
})

test('disabling a customer immediately revokes their browser session', async ({
  page,
  browser,
}) => {
  await login(page)
  const email = await createCustomer(page)
  const user = await db.user.findUniqueOrThrow({ where: { loginEmail: email } })
  const invitation = await (
    await post(page, '/admin/users/' + user.id + '/invitations', {})
  ).json()
  const context = await browser.newContext({ baseURL: env.APP_BASE_URL })
  try {
    const customerPage = await context.newPage()
    await activate(customerPage, invitation.url)
    await customerPage.goto('/login')
    await customerPage
      .getByRole('textbox', { name: '登录邮箱', exact: true })
      .fill(email)
    await customerPage
      .getByLabel('密码', { exact: true })
      .fill(customerPassword)
    await submitLogin(customerPage)
    await expect(customerPage).toHaveURL('/profile')
    const response = await page.request.patch(
      '/api/v1/admin/users/' + user.id + '/status',
      {
        headers: {
          origin: env.APP_BASE_URL,
          'x-requested-with': 'MembershipStore',
        },
        data: { disabled: true, reason: '浏览器会话撤销验收' },
      },
    )
    expect(response.status()).toBe(200)
    await customerPage.reload()
    await expect(customerPage).toHaveURL(/\/login/)
    expect((await customerPage.request.get('/api/v1/auth/me')).status()).toBe(
      401,
    )
  } finally {
    await context.close()
  }
})
