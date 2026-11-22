import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // Read only the API port into server configuration; no secret is exposed to Vite's client env.
  const port =
    process.env.API_PORT ??
    loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'API_PORT')
      .API_PORT ??
    '3000'
  const target = process.env.TEST_API_ORIGIN ?? 'http://127.0.0.1:' + port
  const url = new URL(target)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('The API proxy must target local HTTP.')
  const proxy = { '/api': { target, changeOrigin: false } }
  return {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      proxy,
      fs: {
        allow: ['./', '../node_modules', '../backend/src/contracts'].map(
          (path) => fileURLToPath(new URL(path, import.meta.url)),
        ),
      },
    },
    preview: { host: '127.0.0.1', proxy },
  }
})
