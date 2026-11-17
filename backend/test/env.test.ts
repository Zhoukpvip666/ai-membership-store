import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseEnvironment,
  parseDatabaseEnvironment,
  EnvironmentError,
} from '../src/config/env.ts'

const valid = {
  DATABASE_URL:
    'mysql://test:local-test-only-password@127.0.0.1:3307/foundation_test',
  APP_BASE_URL: 'http://localhost:5173',
  ADMIN_EMAIL: ' Owner@Example.com ',
  ADMIN_PASSWORD: 'local-test-only-password',
}

test('environment normalizes admin email and defaults API port', () => {
  const env = parseEnvironment(valid)
  assert.equal(env.ADMIN_EMAIL, 'owner@example.com')
  assert.equal(env.API_PORT, 3000)
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() =>
      parseEnvironment({
        ...valid,
        APP_BASE_URL: `http://${host}:5173`,
        DATABASE_URL: `mysql://user:p%40ss%3Aword%2F%3F@${host}:3307/foundation_test`,
      }),
    )
  }
})

test('environment failures list field names without secret inputs', () => {
  assert.throws(
    () => parseEnvironment({}),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentError)
      assert.equal(
        error.message,
        'Invalid environment: ADMIN_EMAIL, ADMIN_PASSWORD, APP_BASE_URL, DATABASE_URL. Check .env.example.',
      )
      return true
    },
  )
  const secret = 'must-not-appear'
  assert.throws(
    () =>
      parseEnvironment({
        ...valid,
        DATABASE_URL: `mysql://user:${secret}@remote.invalid/db`,
        ADMIN_EMAIL: secret,
      }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentError)
      assert.ok(!error.message.includes(secret))
      assert.match(error.message, /ADMIN_EMAIL, DATABASE_URL/)
      return true
    },
  )
})

test('database config rejects remote, incomplete and unsupported connection URLs', () => {
  for (const DATABASE_URL of [
    'postgresql://user:password@localhost/db',
    'mysql://user:password@localhost.example/db',
    'mysql://user:password@192.168.1.10/db',
    'mysql://user@localhost/db',
    'mysql://:password@localhost/db',
    'mysql://user:password@localhost/',
    'mysql://user:password@localhost:0/db',
    'mysql://user:password@localhost:65536/db',
    'mysql://user:%xx@localhost/db',
    'mysql://user:replace_with_password@localhost/db',
    'mysql://user:password@localhost/db?host=remote.invalid',
    'mysql://user:password@localhost/db#secret',
  ])
    assert.throws(
      () => parseDatabaseEnvironment({ DATABASE_URL }),
      EnvironmentError,
    )
})

test('application config rejects public origins, weak/placeholders and invalid ports', () => {
  for (const APP_BASE_URL of [
    'https://example.com',
    'http://user:pass@localhost',
    'http://localhost/path',
    'http://localhost/?token=secret',
  ]) {
    assert.throws(
      () => parseEnvironment({ ...valid, APP_BASE_URL }),
      EnvironmentError,
    )
  }
  for (const ADMIN_PASSWORD of [
    'short',
    ' '.repeat(20),
    'x'.repeat(129),
    'replace_with_local_admin_password',
  ]) {
    assert.throws(
      () => parseEnvironment({ ...valid, ADMIN_PASSWORD }),
      EnvironmentError,
    )
  }
  for (const API_PORT of ['0', '65536', '-1', 'abc', '1.5', '']) {
    assert.throws(
      () => parseEnvironment({ ...valid, API_PORT }),
      EnvironmentError,
    )
  }
})

test('server and seed exit before connecting on invalid env without leaking values', () => {
  for (const script of ['src/server.ts', 'prisma/seed.ts']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...valid,
        DATABASE_URL: 'mysql://user:do-not-log-this@remote.invalid/db',
      },
      timeout: 15000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Invalid environment: DATABASE_URL/)
    assert.ok(!result.stderr.includes('do-not-log-this'))
    assert.ok(!result.stdout.includes('Local API:'))
  }
})
