import { describe, expect, it } from 'vitest'
import { createMockStore } from './mock'
import { overview, parsePrice } from './format'

describe('local prototype behavior', () => {
  it('checkout snapshots the configured price without claiming payment', () => {
    const store = createMockStore()
    const result = store.checkout(
      'p1',
      'demo@example.com',
      'target@example.com',
    )
    expect(result.amountFen).toBe(12900)
    expect(result.paid).toBe(false)
    expect(result.status).toBe('PENDING')
    store.state.products[0]!.priceFen = 100
    expect(result.amountFen).toBe(12900)
    expect(() => store.complete(result.id)).toThrow()
    expect(() => store.requestRefund(result.id)).toThrow()
  })
  it('rejects invalid forms, signed-out checkout, and disabled purchasing', () => {
    const store = createMockStore()
    expect(() =>
      store.checkout('p1', 'invalid', 'target@example.com'),
    ).toThrow()
    expect(() => store.checkout('p1', 'demo@example.com', '')).toThrow()
    store.state.products[0]!.purchaseEnabled = false
    expect(() =>
      store.checkout('p1', 'demo@example.com', 'target@example.com'),
    ).toThrow()
    store.state.signedIn = false
    expect(() =>
      store.checkout('p2', 'demo@example.com', 'target@example.com'),
    ).toThrow()
  })
  it('keeps listing, purchase, and renewal controls independent', () => {
    const store = createMockStore()
    const sub = store.state.subscriptions[0]!
    const product = store.product(sub.productId)!
    product.listed = false
    product.purchaseEnabled = false
    expect(store.canRenew(sub)).toBe(true)
    const expiry = sub.expiresAt
    const oldIds = [...sub.orderIds]
    const renewal = store.checkout(
      product.id,
      'demo@example.com',
      sub.target,
      sub.id,
    )
    expect(renewal.kind).toBe('RENEWAL')
    expect(renewal.amountFen).toBe(product.renewalPriceFen)
    expect(sub.expiresAt).toBe(expiry)
    expect(sub.orderIds).toEqual([...oldIds, renewal.id])
    product.renewalEnabled = false
    expect(store.canRenew(sub)).toBe(false)
    expect(sub.status).toBe('ACTIVE')
    expect(() =>
      store.checkout(product.id, 'demo@example.com', sub.target, sub.id),
    ).toThrow()
    expect(() =>
      store.checkout('p1', 'demo@example.com', 'x@example.com', 'SUB-1005'),
    ).toThrow()
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
    expect(() => store.requestRefund(order.id)).toThrow()
    expect(() => store.complete(order.id)).toThrow()
    store.resolveRefund(order.id, false)
    expect(order.status).toBe('PENDING')
    expect(order.refund).toBe('FAILED')
    store.requestRefund(order.id)
    store.resolveRefund(order.id, true)
    expect(order.status).toBe('REFUNDED')
    expect(order.refund).toBe('SUCCESS')
    expect(() => store.resolveRefund(order.id, true)).toThrow()
    expect(() => store.requestRefund(order.id)).toThrow()
  })
  it('requires whole minor-unit prices and required subscription fields', () => {
    expect(parsePrice('9.09')).toBe(909)
    expect(parsePrice('0.01')).toBe(1)
    expect(() => parsePrice('9.009')).toThrow()
    const store = createMockStore()
    const input = { ...store.state.products[0]!, priceFen: 1.1 }
    expect(() => store.saveProduct(input)).toThrow()
    expect(() =>
      store.saveProduct({ ...input, priceFen: 100, renewalPriceFen: null }),
    ).toThrow()
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
