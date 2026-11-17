import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = 'membership-foundation-' + randomBytes(6).toString('hex')
const directory = mkdtempSync(join(tmpdir(), 'membership-foundation-'))
const envFile = join(directory, 'test.env')
const password = randomBytes(24).toString('hex')
const rootPassword = randomBytes(24).toString('hex')
const adminPassword = randomBytes(24).toString('hex')
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
) {
  try {
    return execFileSync(binary, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 180000,
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

try {
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
    APP_BASE_URL: 'http://localhost:5173',
    ADMIN_EMAIL: 'owner@example.com',
    ADMIN_PASSWORD: adminPassword,
    FOUNDATION_DB_TEST: project,
  }
  run(process.execPath, ['scripts/prisma.ts', 'migrate', 'deploy'], env)
  const repeated = run(
    process.execPath,
    ['scripts/prisma.ts', 'migrate', 'deploy'],
    env,
  )
  if (!repeated.includes('No pending migrations'))
    throw new Error('Repeated migration was not a no-op.')
  run(process.execPath, ['scripts/prisma.ts', 'migrate', 'status'], env)
  console.info(
    'Initial migration applied; repeated deploy has no pending migrations.',
  )
  console.info(
    run(process.execPath, ['--test', 'test/integration/database.test.ts'], env),
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
  console.info(`Isolated MySQL port mapping: ${address} -> ${restartedAddress}`)
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
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Database integration tests failed.',
  )
  process.exitCode = 1
} finally {
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
  rmdirSync(directory)
}
