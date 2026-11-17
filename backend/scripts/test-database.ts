import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
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
const browserMode = process.argv.includes('--e2e')
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
) {
  try {
    return execFileSync(binary, args, {
      cwd: commandCwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: browserMode ? 300000 : 180000,
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
    APP_BASE_URL: browserMode
      ? 'http://127.0.0.1:4175'
      : 'http://localhost:5173',
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
  if (browserMode) {
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
          ...process.argv.slice(2).filter((argument) => argument !== '--e2e'),
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
  rmdirSync(directory)
}
