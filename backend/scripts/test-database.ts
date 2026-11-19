import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = 'membership-foundation-' + randomBytes(6).toString('hex')
const directory = mkdtempSync(join(tmpdir(), 'membership-foundation-'))
const envFile = join(directory, 'test.env')
const upgradeSnapshot = join(directory, 'upgrade.json')
const orderUpgradeSnapshot = join(directory, 'order-upgrade.json')
const sourceUpgradeSnapshot = join(directory, 'source-upgrade.json')
const password = randomBytes(24).toString('hex')
const rootPassword = randomBytes(24).toString('hex')
const adminPassword = randomBytes(24).toString('hex')
const browserMode = process.argv.includes('--e2e')
const requestedFreshInstall = process.argv.includes('--fresh')
const modelsOnly = process.argv.includes('--models-only')
const ordersOnly = process.argv.includes('--orders-only')
const productsOnly = process.argv.includes('--products-only')
const revisionsOnly = process.argv.includes('--revisions-only')
const revisionUpgradeSnapshot = join(directory, 'revision-upgrade.json')
// Protected history cannot be deleted to prepare empty-database API/seed tests.
// Full regression first verifies history in a separate disposable project, then
// runs its existing empty-database suites against this independently fresh one.
const freshInstall =
  revisionsOnly ||
  productsOnly ||
  ordersOnly ||
  requestedFreshInstall ||
  (!modelsOnly && !browserMode)
let apiProcess: ChildProcess | undefined
writeFileSync(
  envFile,
  `MYSQL_PASSWORD=${password}\nMYSQL_ROOT_PASSWORD=${rootPassword}\n`,
  { mode: 0o600 },
)
const compose = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '-f',
  'test/compose.yaml',
]

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  commandCwd = cwd,
  timeout = browserMode ? 600000 : 180000,
) {
  try {
    return execFileSync(binary, args, {
      cwd: commandCwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
    })
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    const safeOutput = String(result.stdout ?? '') + String(result.stderr ?? '')
    // eslint-disable-next-line preserve-caught-error -- Raw process errors may retain credentials.
    throw new Error(
      safeOutput
        .replaceAll(password, '[redacted]')
        .replaceAll(rootPassword, '[redacted]')
        .replaceAll(adminPassword, '[redacted]') ||
        'Database test command failed.',
    )
  }
}

function runModelTests(env: NodeJS.ProcessEnv) {
  // Paid renewal fixtures intentionally remain; no later API/seed suite sees them.
  for (const suite of [
    'order-models.test.ts',
    'renewal-integrity.test.ts',
    'order-source.test.ts',
  ])
    console.info(
      run(process.execPath, ['--test', 'test/integration/' + suite], env),
    )
}

try {
  if (
    !browserMode &&
    !modelsOnly &&
    !ordersOnly &&
    !productsOnly &&
    !revisionsOnly &&
    !requestedFreshInstall
  )
    console.info(
      run(
        process.execPath,
        ['scripts/test-database.ts', '--models-only'],
        process.env,
        cwd,
        600000,
      ),
    )
  if (
    !browserMode &&
    !modelsOnly &&
    !ordersOnly &&
    !productsOnly &&
    !revisionsOnly &&
    !requestedFreshInstall
  )
    console.info(
      run(
        process.execPath,
        ['scripts/test-database.ts', '--orders-only'],
        process.env,
        cwd,
        600000,
      ),
    )
  console.info(`Starting isolated MySQL 8.4 project: ${project}`)
  run('docker', [...compose, 'up', '-d', '--wait', 'mysql'])
  const databaseAddress = () => {
    const address = run('docker', [...compose, 'port', 'mysql', '3306']).trim()
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Test database must bind to loopback.')
    return address
  }
  const address = databaseAddress()
  const env = {
    ...process.env,
    DATABASE_URL: `mysql://foundation_test:${password}@${address}/foundation_test`,
    APP_BASE_URL: browserMode
      ? 'http://127.0.0.1:4175'
      : 'http://localhost:5173',
    ADMIN_EMAIL: 'owner@example.com',
    ADMIN_PASSWORD: adminPassword,
    FOUNDATION_DB_TEST: project,
  }
  if (!browserMode && !freshInstall) {
    // Exercise the actual committed old schema with populated records before upgrading.
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'db',
        'execute',
        '--file',
        'prisma/migrations/20261117000000_init_local_operations/migration.sql',
      ],
      env,
    )
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'migrate',
        'resolve',
        '--applied',
        '20261117000000_init_local_operations',
      ],
      env,
    )
    run(
      process.execPath,
      ['test/integration/upgrade.ts', 'before', upgradeSnapshot],
      env,
    )
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'db',
        'execute',
        '--file',
        'prisma/migrations/20261117010000_product_form_schema/migration.sql',
      ],
      env,
    )
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'migrate',
        'resolve',
        '--applied',
        '20261117010000_product_form_schema',
      ],
      env,
    )
    run(
      process.execPath,
      ['test/integration/upgrade.ts', 'forms', upgradeSnapshot],
      env,
    )
  }
  if (!browserMode && !freshInstall)
    console.info(
      run(
        process.execPath,
        ['test/integration/upgrade.ts', 'guard', upgradeSnapshot],
        env,
      ),
    )
  if (!browserMode && !freshInstall) {
    // Populate the first five migrations before applying the review follow-up.
    for (const migration of [
      '20261117020000_product_listing_archive',
      '20261117030000_user_subscription_core',
      '20261118000000_order_subscription_foundation',
    ]) {
      run(
        process.execPath,
        [
          'scripts/prisma.ts',
          'db',
          'execute',
          '--file',
          `prisma/migrations/${migration}/migration.sql`,
        ],
        env,
      )
      run(
        process.execPath,
        ['scripts/prisma.ts', 'migrate', 'resolve', '--applied', migration],
        env,
      )
    }
  }
  const migrationEnv = {
    ...env,
    DATABASE_URL: `mysql://root:${rootPassword}@${address}/foundation_test`,
  }
  // Native client performs the first caching_sha2_password exchange securely
  // inside the disposable container, before the Node adapter's DBA preflight.
  run('docker', [
    ...compose,
    'exec',
    '-T',
    'mysql',
    'sh',
    '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h mysql -u root -D foundation_test -N -e "SELECT 1"',
  ])
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createDatabase } from './src/db/client.ts';
    const db = createDatabase(process.env.DATABASE_URL);
    try { await db.$queryRawUnsafe('SELECT 1'); }
    catch (error) {
      console.error('Disposable DBA probe: ' + String(error).replaceAll(process.env.DATABASE_URL, '[connection]'));
      process.exitCode = 1;
    } finally { await db.$disconnect(); }
  `,
    ],
    migrationEnv,
  )
  if (!browserMode && !freshInstall) {
    // Exercise the sixth-to-seventh upgrade, preserving every populated old row.
    const sixth = '20261118010000_order_subscription_integrity'
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'db',
        'execute',
        '--file',
        `prisma/migrations/${sixth}/migration.sql`,
      ],
      migrationEnv,
    )
    run(
      process.execPath,
      ['scripts/prisma.ts', 'migrate', 'resolve', '--applied', sixth],
      migrationEnv,
    )
    console.info(
      run(
        process.execPath,
        ['test/integration/paid-at-migration-guard.ts'],
        env,
      ),
    )
    run(
      process.execPath,
      ['test/integration/order-upgrade.ts', 'before', orderUpgradeSnapshot],
      env,
    )
    // Verify the old migration contract before authorized disposable-fixture cleanup.
    const seventh = '20261118020000_order_paid_at'
    run(
      process.execPath,
      [
        'scripts/prisma.ts',
        'db',
        'execute',
        '--file',
        `prisma/migrations/${seventh}/migration.sql`,
      ],
      migrationEnv,
    )
    run(
      process.execPath,
      ['scripts/prisma.ts', 'migrate', 'resolve', '--applied', seventh],
      migrationEnv,
    )
    console.info(
      run(
        process.execPath,
        ['test/integration/order-upgrade.ts', 'after', orderUpgradeSnapshot],
        env,
      ),
    )
    unlinkSync(orderUpgradeSnapshot)
    console.info(
      run(
        process.execPath,
        ['test/integration/upgrade.ts', 'after', upgradeSnapshot],
        env,
      ),
    )
    unlinkSync(upgradeSnapshot)
    // Exercise the final migration's fail-fast preflight against old synthetic
    // orders, then remove only those fixtures before protected migrations 8/9.
    run(
      process.execPath,
      [
        'test/integration/order-source-upgrade.ts',
        'before',
        sourceUpgradeSnapshot,
      ],
      env,
    )
    // Also verify a genuinely populated ninth-to-tenth upgrade: removing the
    // first ENUM member must preserve already valid source values/references.
    for (const migration of [
      '20261118030000_order_source_guard',
      '20261118040000_order_source_identity',
    ]) {
      run(
        process.execPath,
        [
          'scripts/prisma.ts',
          'db',
          'execute',
          '--file',
          `prisma/migrations/${migration}/migration.sql`,
        ],
        migrationEnv,
      )
      run(
        process.execPath,
        ['scripts/prisma.ts', 'migrate', 'resolve', '--applied', migration],
        migrationEnv,
      )
    }
    run(
      process.execPath,
      [
        'test/integration/order-source-upgrade.ts',
        'ready',
        sourceUpgradeSnapshot,
      ],
      env,
    )
  }
  if (revisionsOnly && !requestedFreshInstall && !browserMode) {
    // Exercise committed history in a disposable database, never rewrite SQL.
    for (const migration of readdirSync(join(cwd, 'prisma/migrations'))
      .filter(
        (name) =>
          /^2026/.test(name) &&
          name !== '20261119000000_order_revision_foundation',
      )
      .sort()) {
      run(
        process.execPath,
        [
          'scripts/prisma.ts',
          'db',
          'execute',
          '--file',
          `prisma/migrations/${migration}/migration.sql`,
        ],
        migrationEnv,
      )
      run(
        process.execPath,
        ['scripts/prisma.ts', 'migrate', 'resolve', '--applied', migration],
        migrationEnv,
      )
    }
    run(process.execPath, ['test/integration/product-fixture.ts'], env)
    console.info(
      run(
        process.execPath,
        [
          'test/integration/revision-upgrade.ts',
          'before',
          revisionUpgradeSnapshot,
        ],
        env,
      ),
    )
  }
  run(
    process.execPath,
    ['scripts/prisma.ts', 'migrate', 'deploy'],
    migrationEnv,
  )
  if (!browserMode && !freshInstall) {
    console.info(
      run(
        process.execPath,
        [
          'test/integration/order-source-upgrade.ts',
          'after',
          sourceUpgradeSnapshot,
        ],
        env,
      ),
    )
    unlinkSync(sourceUpgradeSnapshot)
  }
  const repeated = run(
    process.execPath,
    ['scripts/prisma.ts', 'migrate', 'deploy'],
    migrationEnv,
  )
  if (!repeated.includes('No pending migrations'))
    throw new Error('Repeated migration was not a no-op.')
  run(process.execPath, ['scripts/prisma.ts', 'migrate', 'status'], env)
  run(
    process.execPath,
    [
      'scripts/prisma.ts',
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ],
    env,
  )
  console.info(
    'Versioned migrations applied; repeated deploy has no pending migrations; database matches Prisma schema.',
  )
  if (revisionsOnly && !requestedFreshInstall && !browserMode) {
    console.info(
      run(
        process.execPath,
        [
          'test/integration/revision-upgrade.ts',
          'after',
          revisionUpgradeSnapshot,
        ],
        env,
      ),
    )
    unlinkSync(revisionUpgradeSnapshot)
  }
  if (
    productsOnly ||
    (revisionsOnly && (requestedFreshInstall || browserMode))
  ) {
    // Fresh runner-owned database, fictional login/settings fixtures; never Seed.
    run(process.execPath, ['test/integration/product-fixture.ts'], env)
  }
  if (revisionsOnly && !browserMode) {
    for (const suite of ['order-revisions.test.ts', 'subscriptions.test.ts'])
      console.info(
        run(process.execPath, ['--test', 'test/integration/' + suite], env),
      )
  } else if (productsOnly && !browserMode) {
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/products.test.ts'],
        env,
      ),
    )
  } else if (ordersOnly) {
    // Fresh, runner-owned MySQL only. No Seed CLI, seedAdministrator, worker or browser.
    console.info(
      run(process.execPath, ['--test', 'test/integration/orders.test.ts'], env),
    )
  } else if (modelsOnly) {
    // No Seed CLI or seedAdministrator calls. Only fictional, non-login fixture
    // identity/settings in the guarded disposable database support FK tests.
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createDatabase } from './src/db/client.ts';
      import { integrationEnvironment } from './test/integration/support.ts';
      import assert from 'node:assert/strict';
      const db = createDatabase(integrationEnvironment().DATABASE_URL);
      try {
        const versions = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
        const tables = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        assert.equal(Number(versions[0].n), 11);
        assert.equal(Number(tables[0].n), 14);
        if (await db.user.count() === 0) {
          await db.user.create({ data: { loginEmail: 'model-fixture@example.com', role: 'ADMIN', status: 'DISABLED' } });
          await db.appSettings.create({ data: { id: 1, storeName: 'Isolated model fixture', ownerEmail: 'model-fixture@example.com' } });
        } else {
          assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
          assert.equal(await db.order.count(), 3);
          assert.equal(await db.appSettings.count(), 1);
        }
      } finally { await db.$disconnect(); }
    `,
      ],
      env,
    )
    console.info('Models-only: no Seed, API or browser suites are executed.')
    runModelTests(env)
  } else if (requestedFreshInstall && !browserMode) {
    // The upgrade path runs the full API regression suite; fresh installation
    // independently checks empty-schema deployment and every model constraint.
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/database.test.ts'],
        env,
      ),
    )
    run(process.execPath, ['scripts/prisma.ts', 'db', 'seed'], env)
    run(process.execPath, ['scripts/prisma.ts', 'db', 'seed'], env)
    runModelTests(env)
  } else if (browserMode) {
    if (!productsOnly && !revisionsOnly)
      run(process.execPath, ['scripts/prisma.ts', 'db', 'seed'], env)
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const location = reservation.address()
    if (!location || typeof location === 'string')
      throw new Error('No isolated API port.')
    const apiPort = location.port
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    )
    const apiOrigin = 'http://127.0.0.1:' + apiPort
    apiProcess = spawn(process.execPath, ['src/server.ts'], {
      cwd,
      env: { ...env, API_PORT: String(apiPort) },
      stdio: 'pipe',
    })
    let apiFailure = false
    apiProcess.once('error', () => {
      apiFailure = true
    })
    // Drain output without exposing credentials or retaining raw request data.
    apiProcess.stdout?.resume()
    apiProcess.stderr?.resume()
    let ready = false
    const deadline = Date.now() + 20000
    while (
      Date.now() < deadline &&
      !apiFailure &&
      apiProcess.exitCode === null
    ) {
      try {
        const response = await fetch(apiOrigin + '/api/v1/health', {
          signal: AbortSignal.timeout(1000),
        })
        ready = response.ok && (await response.json()).database === 'ready'
        if (ready) break
      } catch {
        /* The isolated API may still be starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready)
      throw new Error('The isolated browser-test API did not become ready.')
    console.info(
      run(
        process.execPath,
        [
          createRequire(import.meta.url).resolve('@playwright/test/cli'),
          'test',
          '--config',
          join(cwd, '..', 'playwright.config.ts'),
          ...process.argv
            .slice(2)
            .filter(
              (argument) =>
                !['--e2e', '--products-only', '--revisions-only'].includes(
                  argument,
                ),
            ),
        ],
        { ...env, TEST_API_ORIGIN: apiOrigin },
        join(cwd, '..'),
      ),
    )
  } else {
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/database.test.ts'],
        env,
      ),
    )
    // Exercise the actual Prisma seed CLI too, after the idempotency assertions.
    run(process.execPath, ['scripts/prisma.ts', 'db', 'seed'], env)
    run(process.execPath, ['scripts/prisma.ts', 'db', 'seed'], env)
    console.info('Prisma seed CLI repeated safely.')
    run('docker', [...compose, 'stop', 'mysql'])
    console.info(
      run(process.execPath, ['--test', 'test/integration/readiness.test.ts'], {
        ...env,
        EXPECT_DB_READY: '0',
      }),
    )
    run('docker', [...compose, 'up', '-d', '--wait', 'mysql'])
    // Docker may reallocate a randomly published host port after stop/start.
    // Rediscover it instead of probing the original, now closed mapping.
    const restartedAddress = databaseAddress()
    console.info(
      `Isolated MySQL port mapping: ${address} -> ${restartedAddress}`,
    )
    env.DATABASE_URL = `mysql://foundation_test:${password}@${restartedAddress}/foundation_test`
    console.info(
      run(process.execPath, ['--test', 'test/integration/readiness.test.ts'], {
        ...env,
        EXPECT_DB_READY: '1',
      }),
    )
    console.info(
      'MySQL restart preserved the administrator and migration; readiness recovered.',
    )
    console.info(
      run(process.execPath, ['--test', 'test/integration/auth.test.ts'], env),
    )
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/products.test.ts'],
        env,
      ),
    )
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/subscriptions.test.ts'],
        env,
      ),
    )
    run('docker', [...compose, 'stop', 'mysql'])
    run('docker', [...compose, 'up', '-d', '--wait', 'mysql'])
    env.DATABASE_URL = `mysql://foundation_test:${password}@${databaseAddress()}/foundation_test`
    console.info(
      run(
        process.execPath,
        ['--test', 'test/integration/products-restart.test.ts'],
        env,
      ),
    )
    runModelTests(env)
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Database integration tests failed.',
  )
  process.exitCode = 1
} finally {
  if (apiProcess && apiProcess.exitCode === null) {
    const exited = once(apiProcess, 'exit')
    apiProcess.kill()
    await exited
  }
  try {
    // This exact random project was created above; never touch the dev project.
    run('docker', [...compose, 'down', '--volumes', '--remove-orphans'])
    console.info('Removed only the isolated test container and volume.')
  } catch {
    console.error(
      `Test cleanup failed. Remove only Docker Compose project ${project}.`,
    )
    process.exitCode = 1
  }
  unlinkSync(envFile)
  try {
    unlinkSync(upgradeSnapshot)
  } catch {
    /* No fixture remains after a successful upgrade. */
  }
  try {
    unlinkSync(orderUpgradeSnapshot)
  } catch {
    /* No order fixture remains after a successful upgrade. */
  }
  try {
    unlinkSync(sourceUpgradeSnapshot)
  } catch {
    /* No source fixture remains after a successful upgrade. */
  }
  try {
    unlinkSync(revisionUpgradeSnapshot)
  } catch {
    /* Optional upgrade artifact. */
  }
  rmdirSync(directory)
}
