import { describe, expect, it } from 'vitest'
import { createMockStore } from './mock'
import {
  isAwaitingDelivery,
  orderDisplayStatus,
  orderLabels,
  overview,
  parsePrice,
} from './format'

describe('local prototype behavior', () => {
  it('unpaid history remains unpaid and cannot be fulfilled or refunded', () => {
    const store = createMockStore()
    const result = store.state.orders.find((item) => !item.paid)!
    expect(result.status).toBe('PENDING')
    expect(result.fulfillment).toBe('NOT_STARTED')
    expect(orderLabels[orderDisplayStatus(result)]).toBe('未付款')
    expect(isAwaitingDelivery(result)).toBe(false)
    expect(() => store.complete(result.id)).toThrow()
    expect(() => store.requestRefund(result.id)).toThrow()
  })
  it('completes a paid pending order once without inferred entitlements', () => {
    const store = createMockStore()
    const subs = JSON.stringify(store.state.subscriptions)
    store.complete('MOCK-1008')
    expect(store.state.orders[0]!.status).toBe('COMPLETED')
    expect(JSON.stringify(store.state.subscriptions)).toBe(subs)
    expect(() => store.complete('MOCK-1008')).toThrow()
  })
  it('refund request stays pending until explicit simulated success', () => {
    const store = createMockStore()
    const order = store.state.orders[0]!
    store.requestRefund(order.id)
    expect(order.status).toBe('PENDING')
    expect(order.refund).toBe('PROCESSING')
    expect(order.fulfillment).toBe('PROCESSING')
    expect(() => store.requestRefund(order.id)).toThrow()
    expect(() => store.complete(order.id)).toThrow()
    store.resolveRefund(order.id, false)
    expect(order.status).toBe('PENDING')
    expect(order.refund).toBe('FAILED')
    expect(order.fulfillment).toBe('PROCESSING')
    const verifiedAt = order.verifiedAt
    store.requestRefund(order.id)
    store.resolveRefund(order.id, true)
    expect(order.status).toBe('REFUNDED')
    expect(order.refund).toBe('SUCCESS')
    expect(order.fulfillment).toBe('CANCELLED')
    expect(order.paid).toBe(true)
    expect(order.verifiedAt).toBe(verifiedAt)
    expect(isAwaitingDelivery(order)).toBe(false)
    expect(() => store.complete(order.id)).toThrow()
    expect(() => store.resolveRefund(order.id, true)).toThrow()
    expect(() => store.requestRefund(order.id)).toThrow()
  })
  it('only confirmed paid pending orders enter the delivery queue', () => {
    const store = createMockStore()
    const stats = () => overview(store.state.orders, 'Asia/Shanghai')
    expect(stats().pending).toBe(2)
    const unpaid = store.state.orders.find((item) => !item.paid)!
    expect(stats().pending).toBe(2)
    expect(orderDisplayStatus(unpaid)).toBe('UNPAID')
    expect(
      orderDisplayStatus(store.state.orders.find((o) => o.id === 'MOCK-1008')!),
    ).toBe('PENDING')
    store.complete('MOCK-1008')
    expect(stats().pending).toBe(1)
    store.requestRefund('MOCK-1007')
    expect(stats().pending).toBe(1)
    store.resolveRefund('MOCK-1007', false)
    expect(stats().pending).toBe(1)
    store.requestRefund('MOCK-1007')
    store.resolveRefund('MOCK-1007', true)
    expect(stats().pending).toBe(0)
    expect(unpaid.paid).toBe(false)
    expect(unpaid.fulfillment).toBe('NOT_STARTED')
  })
  it('keeps refunded fixtures consistent with cancelled fulfillment', () => {
    const store = createMockStore()
    const refunded = store.state.orders.filter((o) => o.status === 'REFUNDED')
    expect(refunded.length).toBeGreaterThan(0)
    for (const order of refunded) {
      expect(order.refund).toBe('SUCCESS')
      expect(order.fulfillment).toBe('CANCELLED')
      expect(order.paid).toBe(true)
      expect(orderDisplayStatus(order)).toBe('REFUNDED')
      expect(isAwaitingDelivery(order)).toBe(false)
    }
  })
  it('parses whole minor-unit prices within the database range', () => {
    expect(parsePrice('9.09')).toBe(909)
    expect(parsePrice('0.01')).toBe(1)
    expect(parsePrice('0')).toBe(0)
    expect(parsePrice('21474836.47')).toBe(2147483647)
    expect(() => parsePrice('21474836.48')).toThrow()
    expect(() => parsePrice('-1')).toThrow()
    expect(() => parsePrice('9.009')).toThrow()
  })
  it('net receipts include verified payments minus confirmed refunds in business timezone', () => {
    const store = createMockStore()
    const order = {
      ...store.state.orders[0]!,
      amountFen: 1000,
      createdAt: '2026-11-01T16:30:00Z',
      verifiedAt: '2026-11-01T16:30:00Z',
    }
    expect(
      overview([order], 'Asia/Shanghai', new Date('2026-11-02T04:00:00Z'))
        .today,
    ).toBe(1000)
    expect(
      overview(
        [{ ...order, refund: 'PROCESSING' }],
        'Asia/Shanghai',
        new Date('2026-11-02T04:00:00Z'),
      ).today,
    ).toBe(1000)
    expect(
      overview(
        [{ ...order, refund: 'SUCCESS', refundedAt: '2026-11-02T01:00:00Z' }],
        'Asia/Shanghai',
        new Date('2026-11-02T04:00:00Z'),
      ).today,
    ).toBe(0)
  })
})
