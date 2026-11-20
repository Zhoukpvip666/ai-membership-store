import { afterEach, expect, test, vi } from 'vitest'
import { OrderRequest } from './orders'
afterEach(() => vi.unstubAllGlobals())
test('unknown response retry preserves exact serialized body/key and changed intent gets a new key', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        order: {
          id: 'ok',
          orderNo: 'number',
          version: 1,
          amountFen: 0,
          paymentStatus: 'NOT_REQUIRED',
          fulfillmentStatus: 'PROCESSING',
        },
      }),
    })
  vi.stubGlobal('fetch', fetch)
  const request = new OrderRequest()
  await expect(
    request.send('/admin/orders/a/internal-note', 'PATCH', {
      internalNote: 'x',
      expectedVersion: 1,
    }),
  ).rejects.toThrow()
  await request.send('/admin/orders/a/internal-note', 'PATCH', {
    expectedVersion: 1,
    internalNote: 'x',
  })
  expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
  expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe(
    fetch.mock.calls[1]![1].headers['Idempotency-Key'],
  )
  await request.send('/admin/orders/a/internal-note', 'PATCH', {
    expectedVersion: 2,
    internalNote: 'y',
  })
  expect(fetch.mock.calls[2]![1].headers['Idempotency-Key']).not.toBe(
    fetch.mock.calls[1]![1].headers['Idempotency-Key'],
  )
})
test('changed intent after uncertain response uses a new key without mutating saved request body', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('lost'))
  vi.stubGlobal('fetch', fetch)
  const request = new OrderRequest(),
    body = { expectedVersion: 1, formData: { account: 'old' } }
  await expect(request.send('/admin/orders/a', 'PATCH', body)).rejects.toThrow()
  body.formData.account = 'new'
  await expect(request.send('/admin/orders/a', 'PATCH', body)).rejects.toThrow()
  expect(JSON.parse(fetch.mock.calls[0]![1].body).formData.account).toBe('old')
  expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).not.toBe(
    fetch.mock.calls[1]![1].headers['Idempotency-Key'],
  )
})

test('unusable successful JSON response retains the original request key for retry', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    .mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        order: {
          id: 'ok',
          orderNo: 'number',
          version: 1,
          amountFen: 0,
          paymentStatus: 'NOT_REQUIRED',
          fulfillmentStatus: 'PROCESSING',
        },
      }),
    })
  vi.stubGlobal('fetch', fetch)
  const request = new OrderRequest()
  await expect(
    request.send('/admin/orders', 'POST', { amountFen: 0 }),
  ).rejects.toThrow('无法确认服务器响应')
  await request.send('/admin/orders', 'POST', { amountFen: 0 })
  expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe(
    fetch.mock.calls[1]![1].headers['Idempotency-Key'],
  )
})
