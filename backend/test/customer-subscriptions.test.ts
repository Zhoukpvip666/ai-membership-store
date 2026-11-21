import assert from 'node:assert/strict'
import test from 'node:test'
import {
  customerSubscriptionDto,
  listCustomerSubscriptions,
} from '../src/modules/subscriptions/customer-read.ts'

const now = new Date('2026-11-21T12:00:00.000Z')
const row = {
  id: 'subscription',
  productNameSnapshot: 'Frozen product',
  termSnapshot: 'One month',
  status: 'ACTIVE' as const,
  startedAt: new Date('2026-10-21T12:00:00.000Z'),
  expiresAt: now,
  renewalPriceFen: 8800,
  sourceOrder: {
    id: 'order',
    orderNo: 'ORD-1',
    userId: 'customer',
    hidden: false,
  },
}

test('customer subscription status expires at the boundary and preserves termination', () => {
  assert.equal(
    customerSubscriptionDto(row, 'customer', new Date(now.getTime() - 1))
      .status,
    'ACTIVE',
  )
  assert.equal(customerSubscriptionDto(row, 'customer', now).status, 'EXPIRED')
  assert.equal(
    customerSubscriptionDto({ ...row, status: 'TERMINATED' }, 'customer', now)
      .status,
    'TERMINATED',
  )
})

test('customer subscription DTO discloses only a visible source order owned by the customer', () => {
  const internal = {
    ...row,
    note: 'private',
    formData: { reference: 'private' },
  }
  assert.deepEqual(customerSubscriptionDto(internal, 'customer', now), {
    id: 'subscription',
    productNameSnapshot: 'Frozen product',
    termSnapshot: 'One month',
    status: 'EXPIRED',
    startedAt: row.startedAt.toISOString(),
    expiresAt: now.toISOString(),
    renewalPriceFen: 8800,
    sourceOrder: { id: 'order', orderNo: 'ORD-1' },
  })
  assert.equal(
    customerSubscriptionDto(internal, 'another', now).sourceOrder,
    null,
  )
  assert.equal(
    customerSubscriptionDto(
      { ...internal, sourceOrder: { ...row.sourceOrder, hidden: true } },
      'customer',
      now,
    ).sourceOrder,
    null,
  )
})

test('customer subscription query rejects owner overrides and invalid status or pagination', () => {
  assert.deepEqual(listCustomerSubscriptions.parse({}), {
    page: 1,
    pageSize: 20,
  })
  assert.deepEqual(
    listCustomerSubscriptions.parse({
      status: 'EXPIRED',
      page: '2',
      pageSize: '5',
    }),
    { status: 'EXPIRED', page: 2, pageSize: 5 },
  )
  for (const input of [
    { userId: 'somebody' },
    { status: 'UNKNOWN' },
    { page: '0' },
    { pageSize: '101' },
  ]) {
    assert.equal(listCustomerSubscriptions.safeParse(input).success, false)
  }
})
