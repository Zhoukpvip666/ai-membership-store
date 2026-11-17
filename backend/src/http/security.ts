import type { RequestHandler } from 'express'
import { ApiError } from './errors.ts'

export function csrf(appBaseUrl: string): RequestHandler {
  const origin = new URL(appBaseUrl).origin
  return (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    if (
      request.get('origin') !== origin ||
      request.get('x-requested-with') !== 'MembershipStore' ||
      !request.is('application/json')
    )
      return next(
        new ApiError(
          403,
          'CSRF_REJECTED',
          '请求来源无效，请从本地应用重新操作',
        ),
      )
    next()
  }
}

export function rateLimit(
  limit: number,
  windowMs = 15 * 60 * 1000,
  now = Date.now,
): RequestHandler {
  const entries = new Map<string, { count: number; expires: number }>()
  return (request, response, next) => {
    const time = now()
    for (const [key, value] of entries)
      if (value.expires <= time) entries.delete(key)
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    let entry = entries.get(key)
    if (!entry) {
      if (entries.size >= 10000)
        return next(
          new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试'),
        )
      entry = { count: 0, expires: time + windowMs }
      entries.set(key, entry)
    }
    if (++entry.count > limit) {
      response.setHeader(
        'Retry-After',
        Math.ceil((entry.expires - time) / 1000),
      )
      return next(new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试'))
    }
    next()
  }
}
