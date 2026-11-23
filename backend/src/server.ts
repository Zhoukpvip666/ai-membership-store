import { createApp } from './app.ts'
import {
  parseEnvironment,
  EnvironmentError,
  requireProductionMode,
} from './config/env.ts'
import { createDatabase, checkDatabase } from './db/client.ts'
import { createGracefulShutdown } from './shutdown.ts'
import { subscriptionService } from './modules/subscriptions/service.ts'
import { startExpiryScheduler } from './modules/subscriptions/scheduler.ts'
import {
  orderTimeoutService,
  startOrderTimeoutScheduler,
} from './modules/orders/timeout.ts'

try {
  if (process.argv.includes('--production')) requireProductionMode()
  const env = parseEnvironment()
  const database = createDatabase(
    env.DATABASE_URL,
    env.MYSQL_AUTH_PUBLIC_KEY_FILE,
  )
  let stopExpiry: () => Promise<void> = async () => {}
  let stopOrders: () => Promise<void> = async () => {}
  let shuttingDown = false
  const server = createApp(() => checkDatabase(database), {
    database,
    env,
  }).listen(env.API_PORT, '127.0.0.1', () => {
    if (shuttingDown) return
    stopExpiry = startExpiryScheduler(
      subscriptionService(database).autoTerminate,
      () =>
        console.error(
          'Subscription expiry sweep failed; will retry next minute.',
        ),
    )
    stopOrders = startOrderTimeoutScheduler(orderTimeoutService(database), () =>
      console.error('Order timeout sweep failed; will retry next minute.'),
    )
    console.info('API listening on 127.0.0.1:' + env.API_PORT)
  })
  const drain = createGracefulShutdown(
    [
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            )
              reject(error)
            else resolve()
          })
        }),
      () => stopExpiry(),
      () => stopOrders(),
    ],
    () => database.$disconnect(),
  )

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void drain().catch(() => {
      console.error('API shutdown failed to close its resources cleanly.')
      process.exitCode = 1
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  server.on('error', () => {
    console.error('API could not start. Check API_PORT availability.')
    process.exitCode = 1
    shutdown()
  })
} catch (error) {
  console.error(
    error instanceof EnvironmentError ? error.message : 'API startup failed.',
  )
  process.exitCode = 1
}
