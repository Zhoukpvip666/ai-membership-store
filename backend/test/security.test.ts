import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import { createApp } from '../src/app.ts'
import { parseEnvironment } from '../src/config/env.ts'
import type { PrismaClient } from '../src/generated/prisma/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
  hashPassword,
  verifyPassword,
  sessionCookie,
} from '../src/modules/auth/security.ts'
import * as schemas from '../src/modules/users/schemas.ts'
import { csrf, rateLimit } from '../src/http/security.ts'
import { errors } from '../src/http/errors.ts'

test('admin settings require a current ADMIN session regardless of storefront navigation', async () => {
  const adminToken = newToken()
  const customerToken = newToken()
  const expiredToken = newToken()
  const fixtures = [
    [adminToken, 'ADMIN', 60_000],
    [customerToken, 'CUSTOMER', 60_000],
    [expiredToken, 'ADMIN', -60_000],
  ] as const
  const sessions = new Map(
    fixtures.map(([token, role, offset]) => [
      tokenHash(token),
      {
        user: { role, status: 'ACTIVE' },
        expiresAt: new Date(Date.now() + offset),
      },
    ]),
  )
  let settingsReads = 0
  const database = {
    session: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        sessions.get(where.tokenHash) ?? null,
    },
    appSettings: {
      findUnique: async () => {
        settingsReads++
        return { id: 1 }
      },
    },
  } as unknown as PrismaClient
  const env = parseEnvironment({
    APP_BASE_URL: 'http://localhost:5173',
    ADMIN_EMAIL: 'owner@example.test',
    ADMIN_PASSWORD: 'FictionalTestPassword2468!',
    DATABASE_URL: 'mysql://test:unused@127.0.0.1:1/unused',
  })
  const server = createApp(async () => {}, { database, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = 'http://127.0.0.1:' + address.port + '/api/v1/admin/settings'
  try {
    assert.equal((await fetch(url)).status, 401)
    for (const [token, status] of [
      [customerToken, 403],
      [expiredToken, 401],
      [adminToken, 200],
    ] as const) {
      const response = await fetch(url, {
        headers: { Cookie: COOKIE_NAME + '=' + token },
      })
      assert.equal(response.status, status)
    }
    assert.equal(settingsReads, 1)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('opaque tokens, hash-only lookup and strict cookie parsing', () => {
  const token = newToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(newToken(), token)
  assert.match(tokenHash(token), /^[a-f0-9]{64}$/)
  assert.equal(sessionCookie(COOKIE_NAME + '=' + token), token)
  assert.equal(
    sessionCookie(COOKIE_NAME + '=' + token + '; ' + COOKIE_NAME + '=' + token),
    undefined,
  )
  assert.equal(sessionCookie(COOKIE_NAME + '=invalid'), undefined)
})

test('passwords are salted Argon2id and wrong passwords/hashes fail closed', async () => {
  const password = 'FictionalTestPassword2468!'
  const first = await hashPassword(password)
  const second = await hashPassword(password)
  assert.match(first, /^\$argon2id\$/)
  assert.notEqual(first, second)
  assert.equal(await verifyPassword(first, password), true)
  assert.equal(await verifyPassword(first, password + 'x'), false)
  assert.equal(await verifyPassword('invalid', password), false)
})

test('customer inputs normalize identities and reject injected passwords, roles and statuses', () => {
  assert.deepEqual(schemas.createCustomer.parse({ adminLabel: ' 客户 ' }), {
    adminLabel: '客户',
  })
  const token = 'a'.repeat(43)
  const password = 'FixturePassword1234'
  assert.equal(
    schemas.register.parse({
      invitationToken: token,
      password,
      email: ' Customer@Example.com ',
    }).email,
    'customer@example.com',
  )
  assert.equal(
    schemas.register.safeParse({ invitationToken: token, password }).success,
    false,
  )
  assert.equal(
    schemas.register.safeParse({
      invitationToken: token,
      password,
      email: 'customer@example.com',
      role: 'ADMIN',
    }).success,
    false,
  )
  for (const key of [
    'password',
    'passwordHash',
    'role',
    'status',
    'activatedAt',
    'loginEmail',
    'notificationEmail',
  ])
    assert.equal(
      schemas.createCustomer.safeParse({
        adminLabel: '客户',
        [key]: 'untrusted',
      }).success,
      false,
    )
  assert.equal(
    schemas.editCustomer.safeParse({ loginEmail: 'changed@example.com' })
      .success,
    false,
  )
  assert.equal(
    schemas.password.safeParse('replace_with_local_admin_password').success,
    false,
  )
  assert.equal(schemas.password.safeParse(' '.repeat(12)).success, false)
  assert.equal(schemas.password.safeParse('a'.repeat(129)).success, false)
})

test('mutations require configured Origin/custom header and rate limits expire', async () => {
  let now = 1000
  const app = express()
  app.use(express.json())
  app.use(csrf('http://localhost:5173'))
  app.post(
    '/limited',
    rateLimit(2, 1000, () => now),
    (_request, response) => response.json({ ok: true }),
  )
  app.use(errors)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = 'http://127.0.0.1:' + address.port + '/limited'
  const headers = {
    origin: 'http://localhost:5173',
    'x-requested-with': 'MembershipStore',
    'content-type': 'application/json',
  }
  try {
    for (const altered of [
      { ...headers, origin: 'http://evil.example' },
      { ...headers, 'x-requested-with': '' },
      { ...headers, origin: '' },
    ])
      assert.equal(
        (await fetch(url, { method: 'POST', headers: altered, body: '{}' }))
          .status,
        403,
      )
    for (const expected of [200, 200, 429])
      assert.equal(
        (await fetch(url, { method: 'POST', headers, body: '{}' })).status,
        expected,
      )
    now += 1001
    assert.equal(
      (await fetch(url, { method: 'POST', headers, body: '{}' })).status,
      200,
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
