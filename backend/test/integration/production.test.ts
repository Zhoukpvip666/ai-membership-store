import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { test, after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { verifyPassword } from '../../src/modules/auth/security.ts'

const clean = 't231_clean_test'
const registered = 't231_registered_test'
const pending = 't231_pending_test'
const origin = 'https://shop.membership-commerce.net'
const cwd = fileURLToPath(new URL('../..', import.meta.url))
const port = process.env.PRODUCTION_TEST_PORT
const marker = process.env.PRODUCTION_TEST_CONTAINER ?? ''
assert.match(
  marker,
  /^membership-production-[a-f0-9]{12}$/,
  'Run via test:production.',
)
assert.ok(port && /^\d+$/.test(port), 'Missing isolated MySQL port.')

function testUrl(field: string, user: string, database: string) {
  const value = new URL(process.env['PRODUCTION_TEST_' + field + '_URL'] ?? '')
  assert.ok(
    value.hostname === '127.0.0.1' &&
      value.port === port &&
      value.pathname === '/' + clean &&
      value.username === user,
    'Invalid isolated target.',
  )
  value.pathname = '/' + database
  return value.href
}

const shell = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('PRODUCTION_TEST_'),
  ),
)
const db = createDatabase(
  testUrl('MIGRATOR', 'migrator', clean),
  shell.MYSQL_AUTH_PUBLIC_KEY_FILE,
)
const registeredDb = createDatabase(
  testUrl('MIGRATOR', 'migrator', registered),
  shell.MYSQL_AUTH_PUBLIC_KEY_FILE,
)
after(() => Promise.all([db.$disconnect(), registeredDb.$disconnect()]))

const choices = [
  {
    email: 'first-owner@example.test',
    password: 'SyntheticOwnerPassword-Alpha24',
  },
  {
    email: 'second-owner@example.test',
    password: 'SyntheticOwnerPassword-Beta24',
  },
]
const replacement = 'SyntheticReplacementPassword24!'
const customerPassword = 'SyntheticCustomerPassword24!'
const exec = promisify(execFile)

async function bootstrap(
  choice = choices[0],
  database = clean,
  credential = 'BOOTSTRAP',
) {
  const role = credential === 'NO_AUDIT' ? 'no_audit' : 'bootstrap'
  const target = testUrl(credential, role, database)
  const env = {
    ...shell,
    NODE_ENV: 'production',
    PRODUCTION_DATABASE_NAME: database,
    BOOTSTRAP_DATABASE_URL: target,
    ADMIN_EMAIL: choice.email,
    ADMIN_PASSWORD: choice.password,
  }
  let ok = true
  let output: string
  try {
    const result = await exec(process.execPath, ['prisma/bootstrap-admin.ts'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    output = result.stdout + result.stderr
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    ok = false
    output = (result.stdout ?? '') + (result.stderr ?? '')
  }
  assert.ok(
    !output.includes(choice.password) &&
      !output.includes(target) &&
      !output.includes('$argon2id$'),
    'Bootstrap output contained sensitive data.',
  )
  return { ok, output }
}

async function withApi(
  database: string,
  verify: (base: string) => Promise<void>,
) {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) =>
    reservation.close((err) => (err ? reject(err) : resolve())),
  )
  const base = 'http://127.0.0.1:' + address.port
  const child = spawn(process.execPath, ['dist/server.js', '--production'], {
    cwd,
    env: {
      ...shell,
      NODE_ENV: 'production',
      PRODUCTION_DATABASE_NAME: database,
      DATABASE_URL: testUrl('API', 'api', database),
      APP_BASE_URL: origin,
      TRUSTED_PROXY_IP: '127.0.0.1',
      API_PORT: String(address.port),
    },
    stdio: 'pipe',
  })
  const exited = once(child, 'exit')
  child.stdout.resume()
  child.stderr.resume()
  try {
    const limit = Date.now() + 35_000
    let ready = false
    while (Date.now() < limit && child.exitCode === null) {
      try {
        const response = await fetch(base + '/api/v1/health', {
          signal: AbortSignal.timeout(1000),
        })
        ready = response.ok && (await response.json()).database === 'ready'
        if (ready) break
      } catch {
        // The compiled application may still be starting.
      }
      await delay(150)
    }
    assert.ok(
      ready,
      'Compiled production API did not become ready with runtime-only credentials.',
    )
    await verify(base)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    const [code] = await exited
    if (process.platform !== 'win32') assert.equal(code, 0)
  }
}

function get(base: string, path: string, Cookie?: string) {
  return fetch(base + '/api/v1' + path, { headers: Cookie ? { Cookie } : {} })
}

function post(
  base: string,
  path: string,
  data: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(base + '/api/v1' + path, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'MembershipStore',
      ...extra,
    },
    body: JSON.stringify(data),
  })
}

function session(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  assert.ok(
    /; Secure/i.test(header) &&
      /; HttpOnly/i.test(header) &&
      /; SameSite=Strict/i.test(header) &&
      /; Path=\//i.test(header),
    'Production session cookie attributes are incomplete.',
  )
  return header.split(';')[0]
}

test('empty production install has complete migration history, schema objects and no data', async () => {
  const [history] = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  assert.equal(Number(history.n), 14)
  const [objects] = await db.$queryRaw<Record<string, bigint>[]>`
    SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tables_n,
      (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE()) AS index_columns_n,
      (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND constraint_type='FOREIGN KEY') AS fks_n,
      (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND constraint_type='CHECK') AS checks_n,
      (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()) AS triggers_n
  `
  assert.equal(Number(objects.tables_n), 14)
  assert.equal(Number(objects.triggers_n), 10)
  for (const key of ['index_columns_n', 'fks_n', 'checks_n'])
    assert.ok(Number(objects[key]) > 0)
  const counts = await Promise.all([
    db.user.count(),
    db.product.count(),
    db.order.count(),
    db.subscription.count(),
    db.appSettings.count(),
    db.paymentTransaction.count(),
  ])
  assert.ok(counts.every((count) => count === 0))
})

test('bootstrap rejects an unmigrated database and rolls back all writes on audit denial', async () => {
  const early = await bootstrap(choices[0], pending)
  assert.equal(early.ok, false)
  assert.match(early.output, /complete release migration history/)
  const noAudit = await bootstrap(choices[0], clean, 'NO_AUDIT')
  assert.equal(noAudit.ok, false)
  assert.match(noAudit.output, /Production bootstrap failed/)
  assert.equal(await db.user.count(), 0)
  assert.equal(await db.appSettings.count(), 0)
  assert.equal(await db.adminAuditLog.count(), 0)
})

test('concurrent explicit bootstrap initializes once and cannot overwrite the owner', async () => {
  const results = await Promise.all(choices.map((choice) => bootstrap(choice)))
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.match(
    results.find((result) => result.ok)!.output,
    /Production administrator initialized/,
  )
  assert.match(
    results.find((result) => !result.ok)!.output,
    /empty User table|bootstrap conflict/,
  )
  assert.equal(await db.user.count(), 1)
  const owner = await db.user.findFirstOrThrow()
  const chosen = choices[results.findIndex((result) => result.ok)]
  assert.equal(owner.id, '00000000-0000-4000-8000-000000000001')
  assert.equal(owner.loginEmail, chosen.email)
  assert.equal(owner.role, 'ADMIN')
  assert.equal(owner.status, 'ACTIVE')
  assert.ok(owner.activatedAt)
  assert.ok(
    owner.passwordHash &&
      (await verifyPassword(owner.passwordHash, chosen.password)),
  )
  assert.equal(await db.appSettings.count(), 1)
  assert.equal(
    (await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).ownerEmail,
    chosen.email,
  )
  assert.equal(
    await db.adminAuditLog.count({
      where: { action: 'ADMIN_BOOTSTRAPPED', actorAdminId: owner.id },
    }),
    1,
  )

  const repeated = await bootstrap({
    email: chosen.email,
    password: replacement,
  })
  assert.equal(repeated.ok, false)
  assert.match(repeated.output, /empty User table/)
  const preserved = await db.user.findUniqueOrThrow({ where: { id: owner.id } })
  assert.ok(
    preserved.passwordHash === owner.passwordHash,
    'Existing administrator password changed.',
  )
  assert.equal(await db.adminAuditLog.count(), 1)
})

test('production API enforces proxy rate limiting, exact Origin, secure cookies and record ownership', async () => {
  const owner = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const credentials = choices.find(
    (choice) => choice.email === owner.loginEmail,
  )!
  await withApi(clean, async (base) => {
    const login = await post(base, '/auth/login', credentials)
    assert.equal(login.status, 200)
    assert.equal((await login.json()).user.role, 'ADMIN')
    const ownerCookie = session(login)
    assert.equal((await get(base, '/admin/users', ownerCookie)).status, 200)
    assert.equal((await get(base, '/admin/users')).status, 401)
    const invitationUser = await post(
      base,
      '/admin/users',
      { loginEmail: 'invitee@example.test' },
      { Cookie: ownerCookie },
    )
    assert.equal(invitationUser.status, 201)
    const invitee = (await invitationUser.json()).user
    const issued = await post(
      base,
      '/admin/users/' + invitee.id + '/invitations',
      {},
      { Cookie: ownerCookie },
    )
    assert.equal(issued.status, 201)
    const invitation = new URL((await issued.json()).url)
    assert.equal(invitation.origin, origin)
    assert.equal(invitation.pathname, '/activate')
    assert.ok(invitation.hash.length > 1)

    const credentialsFor = (index: number) => ({
      email: 'customer-' + index + '@example.test',
      password: customerPassword,
    })
    const invalidHeaders: Record<string, string>[] = [
      {
        Origin: 'http://shop.membership-commerce.net',
        'X-Forwarded-Proto': 'https',
      },
      {
        Origin: 'https://false.example.test',
        'X-Forwarded-Host': 'shop.membership-commerce.net',
      },
      { Origin: origin, 'X-Requested-With': 'other' },
    ]
    for (const headers of invalidHeaders)
      assert.equal(
        (await post(base, '/auth/register', credentialsFor(0), headers)).status,
        403,
      )

    const spoofedLimit = (index: number) =>
      '203.0.113.' + index + ', 198.51.100.20'
    for (let i = 1; i <= 5; i++)
      assert.equal(
        (
          await post(
            base,
            '/auth/register',
            {},
            { 'X-Forwarded-For': spoofedLimit(i) },
          )
        ).status,
        400,
      )
    const limited = await post(base, '/auth/register', credentialsFor(1), {
      'X-Forwarded-For': spoofedLimit(6),
    })
    assert.equal(limited.status, 429)
    assert.ok(limited.headers.has('retry-after'))

    const customers = []
    for (const index of [1, 2]) {
      const registration = await post(
        base,
        '/auth/register',
        credentialsFor(index),
        { 'X-Forwarded-For': '198.51.100.21' },
      )
      assert.equal(registration.status, 201)
      const cookie = session(registration)
      const user = (await registration.json()).user
      assert.equal(user.role, 'CUSTOMER')
      assert.equal(user.status, 'ACTIVE')
      assert.ok(!('passwordHash' in user))
      assert.equal((await get(base, '/admin/users', cookie)).status, 403)
      customers.push({ user, cookie })
    }
    assert.equal(
      (
        await post(
          base,
          '/auth/register',
          { ...credentialsFor(3), role: 'ADMIN' },
          { 'X-Forwarded-For': '198.51.100.21' },
        )
      ).status,
      400,
    )

    const product = await db.product.create({
      data: {
        slug: 'synthetic',
        name: 'Synthetic',
        type: 'SUBSCRIPTION',
        priceFen: 100,
        renewalPriceFen: 100,
        termLabel: 'month',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
      },
    })
    const userId: string = customers[0].user.id
    const order = await db.order.create({
      data: {
        contactEmailSnapshot: credentialsFor(1).email,
        orderNo: '583024917',
        userId,
        productId: product.id,
        source: 'ADMIN',
        createdByAdminId: owner.id,
        kind: 'INITIAL',
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        termSnapshot: 'month',
        servicePeriodUnitSnapshot: 'MONTH',
        servicePeriodCountSnapshot: 1,
        amountFen: 100,
      },
    })
    const subscription = await db.subscription.create({
      data: {
        userId,
        productId: product.id,
        sourceType: 'ADMIN',
        createdByAdminId: owner.id,
        productNameSnapshot: product.name,
        productTypeSnapshot: product.type,
        priceSnapshotFen: 100,
        termSnapshot: 'month',
        renewalPriceFen: 100,
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    for (const path of [
      '/customer/orders/' + order.id,
      '/customer/subscriptions/' + subscription.id,
    ]) {
      assert.equal((await get(base, path, customers[0].cookie)).status, 200)
      assert.equal((await get(base, path, customers[1].cookie)).status, 404)
    }

    const logout = await post(base, '/auth/logout', {}, { Cookie: ownerCookie })
    assert.equal(logout.status, 204)
    session(logout)
    assert.equal((await get(base, '/auth/me', ownerCookie)).status, 401)
  })
})

test('the first public registration is still CUSTOMER and blocks bootstrap while the customer exists', async () => {
  assert.equal(await registeredDb.user.count(), 0)
  await withApi(registered, async (base) => {
    const response = await post(base, '/auth/register', {
      email: 'early@example.test',
      password: customerPassword,
    })
    assert.equal(response.status, 201)
    const cookie = session(response)
    const user = (await response.json()).user
    assert.equal(user.role, 'CUSTOMER')
    assert.equal(user.status, 'ACTIVE')
    assert.equal((await get(base, '/admin/users', cookie)).status, 403)
  })
  const result = await bootstrap(choices[0], registered)
  assert.equal(result.ok, false)
  assert.match(result.output, /empty User table/)
  assert.equal(await registeredDb.user.count({ where: { role: 'ADMIN' } }), 0)
  assert.equal(
    await registeredDb.user.count({ where: { role: 'CUSTOMER' } }),
    1,
  )
  assert.equal(await registeredDb.appSettings.count(), 0)
  assert.equal(await registeredDb.adminAuditLog.count(), 0)
})
