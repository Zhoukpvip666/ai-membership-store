import { createApp } from './app.ts'

const port = Number(process.env.API_PORT ?? 3000)
createApp().listen(port, '127.0.0.1', () => {
  console.info(`Health API: http://127.0.0.1:${port}/api/v1/health`)
})
