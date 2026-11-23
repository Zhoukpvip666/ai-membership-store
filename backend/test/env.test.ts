import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  parseEnvironment,
  parseDatabaseEnvironment,
  parseMigrationEnvironment,
  parseLocalSeedEnvironment,
  parseProductionBootstrapEnvironment,
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
  assert.equal(
    parseLocalSeedEnvironment(valid).ADMIN_EMAIL,
    'owner@example.com',
  )
  assert.ok(!('ADMIN_PASSWORD' in env))
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
        'Invalid environment: APP_BASE_URL, DATABASE_URL. Check .env.example.',
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
      assert.match(error.message, /DATABASE_URL/)
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
      () => parseLocalSeedEnvironment({ ...valid, ADMIN_PASSWORD }),
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

test('product cover storage requires a private absolute path distinct from QR storage', () => {
  const qr = resolve('cover-fixture/qr')
  const cover = resolve('cover-fixture/product-covers')
  assert.equal(
    parseEnvironment({
      ...valid,
      WECHAT_QR_STORAGE_DIR: qr,
      PRODUCT_COVER_STORAGE_DIR: cover,
    }).PRODUCT_COVER_STORAGE_DIR,
    cover,
  )
  for (const PRODUCT_COVER_STORAGE_DIR of [
    'relative/covers',
    qr,
    resolve(qr, 'covers'),
    resolve(qr, '..'),
    fileURLToPath(new URL('../../frontend/public/covers/', import.meta.url)),
    fileURLToPath(new URL('../../node_modules/covers/', import.meta.url)),
    fileURLToPath(new URL('../src/contracts/covers/', import.meta.url)),
  ]) {
    assert.throws(
      () =>
        parseEnvironment({
          ...valid,
          WECHAT_QR_STORAGE_DIR: qr,
          PRODUCT_COVER_STORAGE_DIR,
        }),
      /Invalid environment: PRODUCT_COVER_STORAGE_DIR/,
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
    assert.ok(!result.stdout.includes('API listening'))
  }
})

const storageFixture = resolve(
  realpathSync.native(tmpdir()),
  'membership-env-fixture',
)
const release = fileURLToPath(new URL('../../', import.meta.url))
const storageFields = [
  'WECHAT_QR_STORAGE_DIR',
  'PRODUCT_COVER_STORAGE_DIR',
] as const
const production = {
  NODE_ENV: 'production',
  PRODUCTION_DATABASE_NAME: 'membership_live',
  DATABASE_URL:
    'mysql://shop_api:synthetic-password@127.0.0.1:3309/membership_live',
  APP_BASE_URL: 'https://shop.membership-commerce.net',
  TRUSTED_PROXY_IP: '127.0.0.1',
  MYSQL_AUTH_PUBLIC_KEY_FILE: resolve('test-public-key.pem'),
  WECHAT_QR_STORAGE_DIR: resolve(storageFixture, 'wechat-qr'),
  PRODUCT_COVER_STORAGE_DIR: resolve(storageFixture, 'product-covers'),
}

test('production accepts a named HTTPS origin without bootstrap credentials', () => {
  const env = parseEnvironment(production)
  assert.equal(env.NODE_ENV, 'production')
  assert.equal(env.TRUSTED_PROXY_IP, '127.0.0.1')
  assert.equal(env.APP_BASE_URL, production.APP_BASE_URL)
  assert.ok(!('ADMIN_PASSWORD' in env))
  assert.doesNotThrow(() =>
    parseEnvironment({
      ...production,
      APP_BASE_URL: production.APP_BASE_URL + ':443/',
    }),
  )
})

test('production rejects HTTP, loopback, IPs, placeholder names, and non-origin URLs', () => {
  for (const APP_BASE_URL of [
    'http://shop.membership-commerce.net',
    'https://localhost',
    'https://a.localhost',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://192.168.1.50',
    'https://shop.example.com',
    'https://example.net',
    'https://shop.invalid',
    'https://shop.test',
    'https://user:password@shop.membership-commerce.net',
    'https://@shop.membership-commerce.net',
    'https://shop.membership-commerce.net/about/..',
    'https://shop.membership-commerce.net/?',
    'https://shop.membership-commerce.net/#',
    'https://shop.membership-commerce.net/?x=1',
    'https://shop.membership-commerce.net/#info',
    'https://shop.membership-commerce.net:8443',
    'https://shop.membership-commerce.net:80',
  ])
    assert.throws(
      () => parseEnvironment({ ...production, APP_BASE_URL }),
      /APP_BASE_URL/,
    )
  assert.throws(
    () => parseEnvironment({ ...production, TRUSTED_PROXY_IP: undefined }),
    /TRUSTED_PROXY_IP/,
  )
  assert.throws(
    () => parseEnvironment({ ...production, TRUSTED_PROXY_IP: '0.0.0.0/0' }),
    /TRUSTED_PROXY_IP/,
  )
})

test('only production requires explicit absolute image storage settings', () => {
  for (const field of storageFields) {
    assert.equal(parseEnvironment(production)[field], production[field])
    for (const value of [undefined, '', 'relative/images']) {
      assert.throws(
        () => parseEnvironment({ ...production, [field]: value }),
        new RegExp('Invalid environment: ' + field),
      )
    }
    for (const NODE_ENV of ['development', 'test'])
      assert.equal(parseEnvironment({ ...valid, NODE_ENV })[field], undefined)
  }
})

test('neither production image directory may overlap the release or static web root', () => {
  for (const field of storageFields)
    for (const directory of [
      release,
      resolve(release, '..'),
      resolve(release, '.local-data', 'images'),
      resolve(release, 'frontend', 'dist', 'images'),
    ]) {
      assert.throws(
        () => parseEnvironment({ ...production, [field]: directory }),
        new RegExp('Invalid environment: .*' + field),
      )
    }
  for (const PRODUCT_COVER_STORAGE_DIR of [
    production.WECHAT_QR_STORAGE_DIR,
    resolve(production.WECHAT_QR_STORAGE_DIR, 'covers'),
  ])
    assert.throws(
      () => parseEnvironment({ ...production, PRODUCT_COVER_STORAGE_DIR }),
      /Invalid environment: PRODUCT_COVER_STORAGE_DIR/,
    )
})

test('production rejects a storage alias into the release even when its child is absent', (t) => {
  const directory = mkdtempSync(
    resolve(storageFixture, '..', 'membership-env-alias-'),
  )
  const alias = resolve(directory, 'release')
  symlinkSync(release, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => {
    unlinkSync(alias)
    rmdirSync(directory)
  })
  for (const field of storageFields)
    assert.throws(
      () =>
        parseEnvironment({
          ...production,
          [field]: resolve(alias, 'absent-images'),
        }),
      new RegExp('Invalid environment: ' + field),
    )
})

test('runtime, migration and first bootstrap use separate credentials and explicit database targets', () => {
  const migration = production.DATABASE_URL.replace(
    'shop_api:',
    'shop_migrator:',
  )
  const bootstrap = production.DATABASE_URL.replace(
    'shop_api:',
    'shop_bootstrap:',
  )
  assert.throws(
    () => parseMigrationEnvironment(production),
    /MIGRATION_DATABASE_URL/,
  )
  assert.equal(
    parseMigrationEnvironment({
      ...production,
      MIGRATION_DATABASE_URL: migration,
    }).DATABASE_URL,
    migration,
  )
  assert.throws(
    () =>
      parseMigrationEnvironment({
        ...production,
        MIGRATION_DATABASE_URL: migration.replace(
          'membership_live',
          'another_db',
        ),
      }),
    /PRODUCTION_DATABASE_NAME/,
  )
  assert.throws(
    () => parseLocalSeedEnvironment({ ...valid, NODE_ENV: 'production' }),
    /NODE_ENV/,
  )
  const credentials = {
    NODE_ENV: 'production',
    PRODUCTION_DATABASE_NAME: 'membership_live',
    BOOTSTRAP_DATABASE_URL: bootstrap,
    MYSQL_AUTH_PUBLIC_KEY_FILE: production.MYSQL_AUTH_PUBLIC_KEY_FILE,
    ADMIN_EMAIL: valid.ADMIN_EMAIL,
    ADMIN_PASSWORD: valid.ADMIN_PASSWORD,
  }
  assert.equal(
    parseProductionBootstrapEnvironment(credentials).ADMIN_EMAIL,
    'owner@example.com',
  )
  assert.throws(
    () =>
      parseProductionBootstrapEnvironment({
        ...credentials,
        NODE_ENV: 'development',
      }),
    /NODE_ENV/,
  )
  assert.throws(
    () =>
      parseProductionBootstrapEnvironment({
        ...credentials,
        PRODUCTION_DATABASE_NAME: 'other',
      }),
    /PRODUCTION_DATABASE_NAME/,
  )
  assert.throws(
    () =>
      parseEnvironment({
        ...production,
        DATABASE_URL: production.DATABASE_URL.replace('shop_api:', 'root:'),
      }),
    /DATABASE_URL/,
  )
  assert.throws(
    () =>
      parseProductionBootstrapEnvironment({
        ...credentials,
        PRODUCTION_DATABASE_NAME: 'membership_preview',
        BOOTSTRAP_DATABASE_URL: bootstrap.replace(
          'membership_live',
          'membership_preview',
        ),
      }),
    /PRODUCTION_DATABASE_NAME/,
  )
  for (const field of [
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'MIGRATION_DATABASE_URL',
    'BOOTSTRAP_DATABASE_URL',
    'BACKUP_DATABASE_URL',
    'MYSQL_ROOT_PASSWORD',
  ])
    assert.throws(
      () => parseEnvironment({ ...production, [field]: 'must-not-be-logged' }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentError)
        assert.ok(error.message.includes(field))
        assert.ok(!error.message.includes('must-not-be-logged'))
        return true
      },
    )
})

test('invalid production origins and implicit bootstrap mode exit before connecting', () => {
  for (const [script, env, field] of [
    [
      'src/server.ts',
      { ...production, APP_BASE_URL: 'http://public.example.com' },
      'APP_BASE_URL',
    ],
    [
      'prisma/bootstrap-admin.ts',
      { ...valid, NODE_ENV: 'development' },
      'NODE_ENV',
    ],
  ] as const) {
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15000,
    })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(field))
    assert.ok(!result.stdout.includes('API listening'))
  }
})
