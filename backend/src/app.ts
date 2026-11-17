import express from 'express'

export function createApp(checkDatabase: () => Promise<void>) {
  const app = express()
  app.disable('x-powered-by')

  app.get(['/health', '/api/v1/health'], async (_request, response) => {
    try {
      await checkDatabase()
      response.json({ status: 'ok', database: 'ready' })
    } catch {
      // Do not expose driver errors, credentials or connection strings.
      response.status(503).json({ status: 'degraded', database: 'unavailable' })
    }
  })

  app.use((_request, response) => {
    response
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  return app
}
