import { expect, test, type Page } from '@playwright/test'
import type { Account } from '../frontend/src/api/client.ts'

type Role = Account['role']
const account = (role: Role) => ({
  id: role,
  role,
  status: 'ACTIVE',
  username: role === 'ADMIN' ? '管理员' : '测试客户',
  loginEmail: role.toLowerCase() + '@example.test',
  notificationEmail: null,
})

async function stubSession(page: Page, initial: Role | null = null) {
  let role = initial
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    switch (new URL(request.url()).pathname) {
      case '/api/v1/auth/me':
        return role
          ? route.fulfill({ json: { user: account(role) } })
          : route.fulfill({ status: 401, json: {} })
      case '/api/v1/auth/login':
        role = request.postDataJSON().email.startsWith('admin@')
          ? 'ADMIN'
          : 'CUSTOMER'
        return route.fulfill({ json: { user: account(role) } })
      case '/api/v1/auth/logout':
        role = null
        return route.fulfill({ status: 204 })
      case '/api/v1/admin/settings':
        return route.fulfill({
          json: {
            settings: {
              id: 1,
              storeName: 'AI 会员商店',
              timezone: 'Asia/Shanghai',
            },
          },
        })
      case '/api/v1/admin/users':
      case '/api/v1/catalog/products':
        return route.fulfill({
          json: { items: [], total: 0, page: 1, pageSize: 20 },
        })
      default:
        throw new Error(
          'Unexpected request in session fixture: ' + request.url(),
        )
    }
  })
  return {
    expire() {
      role = null
    },
  }
}

function consoleLink(page: Page) {
  return page.getByRole('link', { name: '管理控制台', exact: true })
}

async function submitLogin(page: Page, role: Role) {
  await page
    .getByRole('textbox', { name: '登录邮箱' })
    .fill(account(role).loginEmail)
  await page.getByLabel('密码', { exact: true }).fill('FictionalPassword2468!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('guest sees customer-only login navigation and no console link', async ({
  page,
}) => {
  await stubSession(page)
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: '客户登录' })).toBeVisible()
  await expect(page.locator('a[href="/admin/login"]')).toHaveCount(0)
  await page.getByRole('link', { name: '返回商店' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('search')).toBeVisible()
  await expect(consoleLink(page)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('search')).toBeVisible()
  await expect(consoleLink(page)).toHaveCount(0)

  await page.goto('/admin/login')
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()
  await expect(page.getByRole('link', { name: '客户登录' })).toHaveAttribute(
    'href',
    '/login',
  )
  await expect(page.getByRole('link', { name: '返回商店' })).toHaveAttribute(
    'href',
    '/',
  )
})

test('customer and admin login, restored session, direct admin access and logout follow the current role', async ({
  page,
}) => {
  await stubSession(page)
  await page.goto('/login?redirect=/profile')
  await submitLogin(page, 'CUSTOMER')
  await expect(page).toHaveURL('/profile')
  await expect(page.getByText('客户账户', { exact: true })).toBeVisible()
  await expect(consoleLink(page)).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('客户账户', { exact: true })).toBeVisible()
  await expect(consoleLink(page)).toHaveCount(0)
  await page.goto('/admin')
  await expect(page).toHaveURL('/profile')
  await expect(page.getByRole('navigation', { name: '管理导航' })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL('/login')

  await page.goto('/admin/login?redirect=/admin')
  await submitLogin(page, 'ADMIN')
  await expect(page).toHaveURL('/admin')
  await page.getByRole('link', { name: '返回商店' }).click()
  await expect(consoleLink(page)).toHaveAttribute('href', '/admin')
  await page.reload()
  await expect(consoleLink(page)).toBeVisible()
  await consoleLink(page).click()
  await expect(page).toHaveURL('/admin')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL('/admin/login')
  await page.getByRole('link', { name: '返回商店' }).click()
  await expect(page.getByRole('search')).toBeVisible()
  await expect(consoleLink(page)).toHaveCount(0)
})

test('an expired session removes the console link on an already open storefront', async ({
  page,
}) => {
  const session = await stubSession(page, 'ADMIN')
  await page.clock.install()
  await page.goto('/')
  await expect(consoleLink(page)).toBeVisible()

  session.expire()
  await page.clock.fastForward(30_001)
  await expect(consoleLink(page)).toHaveCount(0)
  await expect(page.getByRole('search')).toBeVisible()
})

test('returning to the storefront rechecks an expired session before the next poll', async ({
  page,
}) => {
  const session = await stubSession(page, 'ADMIN')
  await page.clock.install()
  await page.goto('/')
  await expect(consoleLink(page)).toBeVisible()

  session.expire()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(consoleLink(page)).toHaveCount(0)
})

test('logout discards a session check that started while the admin was signed in', async ({
  page,
}) => {
  await stubSession(page, 'ADMIN')
  await page.goto('/profile')
  await expect(consoleLink(page)).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  await page.route(
    '**/api/v1/auth/me',
    async (route) => {
      started = true
      await gate
      await route.fulfill({ json: { user: account('ADMIN') } })
    },
    { times: 1 },
  )

  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => started).toBe(true)
    await Promise.all([
      page.waitForEvent('requestfailed', {
        predicate: (request) => request.url().endsWith('/api/v1/auth/me'),
      }),
      page.getByRole('button', { name: '退出登录' }).click(),
    ])
    await expect(page).toHaveURL('/login')
    await page.getByRole('link', { name: '返回商店' }).click()
    await expect(page.getByRole('search')).toBeVisible()
    await expect(consoleLink(page)).toHaveCount(0)
  } finally {
    release()
  }
})
