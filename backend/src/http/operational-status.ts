import { readFileSync } from 'node:fs'
import type { RequestHandler } from 'express'

const workers = ['subscriptionExpiry', 'orderTimeout'] as const
type Worker = (typeof workers)[number]
type Result = 'succeeded' | 'failed'
type Event = {
  event: 'request' | 'worker' | 'startup' | 'shutdown'
  requestId?: string
  method?: string
  route?: string
  status?: number
  durationMs?: number
  worker?: Worker
  result?: 'listening' | 'stopped' | Result
  backlog?: boolean
  errorCode?: string
}

export type SweepObserver = {
  started: () => void
  completed: (result: Result, backlog: boolean) => void
}

const initialWorker = () => ({
  lastStartedAt: null as number | null,
  lastSucceededAt: null as number | null,
  lastCompletedAt: null as number | null,
  lastDurationMs: null as number | null,
  consecutiveFailures: 0,
  running: false,
  lastResult: null as Result | null,
  backlog: false,
})

export function installedRelease() {
  try {
    const { gitSha } = JSON.parse(
      readFileSync(new URL('../../../release.json', import.meta.url), 'utf8'),
    )
    if (typeof gitSha === 'string' && /^[a-f0-9]{40}$/.test(gitSha))
      return gitSha
  } catch {
    // Local development runs outside a release archive.
  }
  return null
}

const limits = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
const bucket = (minute: number) => ({
  minute,
  count: 0,
  errors: 0,
  maxMs: 0,
  latency: Array<number>(limits.length + 1).fill(0),
})
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
])
function classify(path: string) {
  if (path === '/health' || path === '/api/v1/health') return 'health'
  if (path === '/internal/ops/metrics') return 'metrics'
  if (path.startsWith('/api/v1/auth/')) return 'auth'
  if (path.startsWith('/api/v1/admin/')) return 'admin'
  if (path.startsWith('/api/v1/')) return 'store'
  return 'other'
}

export function operationalStatus(
  releaseSha = installedRelease(),
  sink: (line: string) => void = console.info,
  now = Date.now,
) {
  const startedAt = now()
  const state = {
    subscriptionExpiry: initialWorker(),
    orderTimeout: initialWorker(),
  }
  const recent = Array.from({ length: 5 }, () => bucket(-1))
  const log = (event: Event) =>
    sink(
      JSON.stringify({
        time: new Date(now()).toISOString(),
        releaseSha,
        ...event,
      }),
    )

  const observe = (worker: Worker): SweepObserver => {
    const status = state[worker]
    let started = 0
    return {
      started() {
        started = performance.now()
        status.lastStartedAt = now()
        status.running = true
      },
      completed(result, backlog) {
        status.lastCompletedAt = now()
        status.lastDurationMs = Math.round(performance.now() - started)
        status.running = false
        status.lastResult = result
        status.backlog = backlog
        if (result === 'succeeded') {
          status.lastSucceededAt = status.lastCompletedAt
          status.consecutiveFailures = 0
        } else status.consecutiveFailures++
        log({
          event: 'worker',
          worker,
          result,
          backlog,
          durationMs: status.lastDurationMs,
        })
      },
    }
  }

  const requests: RequestHandler = (request, response, next) => {
    const started = performance.now()
    const route = classify(request.path)
    const method = methods.has(request.method) ? request.method : 'OTHER'
    response.once('finish', () => {
      const durationMs = Math.round(performance.now() - started)
      const status = response.statusCode
      if (route !== 'metrics' && route !== 'health') {
        const minute = Math.floor(now() / 60000)
        const slot = minute % recent.length
        if (recent[slot].minute !== minute) recent[slot] = bucket(minute)
        const sample = recent[slot]
        sample.count++
        if (status >= 500) sample.errors++
        sample.maxMs = Math.max(sample.maxMs, durationMs)
        const bound = limits.findIndex((limit) => durationMs <= limit)
        sample.latency[bound === -1 ? limits.length : bound]++
      }
      log({
        event: 'request',
        requestId: response.locals.requestId,
        method,
        route,
        status,
        durationMs,
        ...(status >= 400 && {
          errorCode: status >= 500 ? 'HTTP_SERVER_ERROR' : 'HTTP_CLIENT_ERROR',
        }),
      })
    })
    next()
  }

  const metrics: RequestHandler = (request, response) => {
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        request.socket.remoteAddress ?? '',
      )
    ) {
      response.sendStatus(404)
      return
    }
    const minute = Math.floor(now() / 60000)
    const window = bucket(minute)
    for (const sample of recent) {
      if (sample.minute < minute - 4 || sample.minute > minute) continue
      window.count += sample.count
      window.errors += sample.errors
      window.maxMs = Math.max(window.maxMs, sample.maxMs)
      sample.latency.forEach((count, index) => (window.latency[index] += count))
    }
    let total = 0
    const p95 = window.latency.findIndex((count) => {
      total += count
      return total >= Math.ceil(window.count * 0.95)
    })
    response.json({
      startedAt,
      releaseSha,
      workers: Object.fromEntries(
        workers.map((worker) => {
          const status = state[worker]
          return [
            worker,
            {
              ...status,
              secondsSinceLastSuccess:
                status.lastSucceededAt === null
                  ? null
                  : Math.max(
                      0,
                      Math.floor((now() - status.lastSucceededAt) / 1000),
                    ),
            },
          ]
        }),
      ),
      requests: {
        count: window.count,
        errors: window.errors,
        p95Ms: window.count ? (limits[p95] ?? window.maxMs) : null,
        latency: window.latency,
        latencyBoundsMs: limits,
      },
    })
  }
  return { log, observe, requests, metrics }
}
