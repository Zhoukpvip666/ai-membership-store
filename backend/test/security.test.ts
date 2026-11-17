import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
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
  assert.equal(
    schemas.createCustomer.parse({
      displayName: ' 客户 ',
      loginEmail: ' Customer@Example.com ',
    }).loginEmail,
    'customer@example.com',
  )
  for (const key of [
    'password',
    'passwordHash',
    'role',
    'status',
    'activatedAt',
  ])
    assert.equal(
      schemas.createCustomer.safeParse({
        displayName: '客户',
        loginEmail: 'customer@example.com',
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
