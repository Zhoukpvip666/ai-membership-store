import { createApp } from './app.ts'
import { parseEnvironment, EnvironmentError } from './config/env.ts'
import { createDatabase, checkDatabase } from './db/client.ts'
import { subscriptionService } from './modules/subscriptions/service.ts'
import { startExpiryScheduler } from './modules/subscriptions/scheduler.ts'

try {
  const env = parseEnvironment()
  const database = createDatabase(env.DATABASE_URL)
  let stopExpiry: () => Promise<void> = async () => {}
  const server = createApp(() => checkDatabase(database), {
    database,
    env,
  }).listen(env.API_PORT, '127.0.0.1', () => {
    stopExpiry = startExpiryScheduler(
      subscriptionService(database).autoTerminate,
      () =>
        console.error(
          'Subscription expiry sweep failed; will retry next minute.',
        ),
    )
    console.info(`Local API: http://127.0.0.1:${env.API_PORT}/api/v1/health`)
  })
  const disconnect = async (exitCode: number) => {
    try {
      await stopExpiry()
      await database.$disconnect()
      process.exitCode = exitCode
    } catch {
      console.error('Local database connection could not close cleanly.')
      process.exitCode = 1
    }
  }
  const shutdown = () => {
    server.close(() => {
      void disconnect(0)
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  server.on('error', () => {
    console.error('Local API could not start. Check API_PORT availability.')
    void disconnect(1)
  })
} catch (error) {
  console.error(
    error instanceof EnvironmentError
      ? error.message
      : 'Local API startup failed.',
  )
  process.exitCode = 1
}
