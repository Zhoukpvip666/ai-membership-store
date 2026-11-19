import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderDeadline } from '../src/modules/orders/dto.ts'
import {
  listAdminOrders,
  listCustomerOrders,
  orderDetailQuery,
} from '../src/modules/orders/schemas.ts'

test('order read queries use bounded pagination, enum filters and deterministic sort defaults', () => {
  assert.deepEqual(listCustomerOrders.parse({}), {
    search: '',
    orderNo: '',
    productName: '',
    sort: 'desc',
    page: 1,
    pageSize: 20,
  })
  assert.equal(
    listAdminOrders.parse({
      customer: ' label ',
      page: '2',
      pageSize: '100',
      sort: 'asc',
    }).customer,
    'label',
  )
  for (const query of [
    { page: '0' },
    { page: '-1' },
    { page: '1.1' },
    { page: '10001' },
    { page: ['1'] },
    { pageSize: '101' },
    { pageSize: '' },
    { pageSize: '1e2' },
    { sort: 'createdAt' },
    { kind: 'INVALID' },
    { paymentStatus: 'COMPLETED' },
    { fulfillmentStatus: 'PAID' },
    { search: 'x'.repeat(255) },
    { orderNo: 'x'.repeat(41) },
    { productName: 'x'.repeat(121) },
    { hidden: 'true' },
    { source: 'ADMIN' },
  ])
    assert.equal(listAdminOrders.safeParse(query).success, false)
})

test('customer and detail queries reject identity, private-label, visibility and unknown overrides', () => {
  for (const query of [
    { userId: 'another-customer' },
    { customer: 'private-label' },
    { adminLabel: 'private-label' },
    { includeHidden: 'true' },
    { 'userId[]': 'another-customer' },
    { user: { id: 'another-customer' } },
  ]) {
    assert.equal(listCustomerOrders.safeParse(query).success, false)
    assert.equal(orderDetailQuery.safeParse(query).success, false)
  }
  assert.equal(orderDetailQuery.safeParse({}).success, true)
})

test('order deadlines use original creation plus exactly 24h and server time, floor seconds and clamp expired/terminal orders to zero', () => {
  const createdAt = new Date('2030-01-31T23:59:59.000Z')
  const order = {
    createdAt,
    paymentStatus: 'UNPAID' as const,
    fulfillmentStatus: 'NOT_STARTED' as const,
    cancelledAt: null,
    paidAt: null,
    paymentConfirmedAt: null,
    fulfilledAt: null,
  }
  const expiresAt = new Date('2030-02-01T23:59:59.000Z')
  assert.deepEqual(orderDeadline(order, createdAt), {
    expiresAt,
    remainingSeconds: 86400,
  })
  assert.equal(
    orderDeadline(order, new Date(createdAt.getTime() + 1500)).remainingSeconds,
    86398,
  )
  assert.equal(orderDeadline(order, expiresAt).remainingSeconds, 0)
  assert.equal(
    orderDeadline(order, new Date(expiresAt.getTime() + 1)).remainingSeconds,
    0,
  )
  for (const paymentStatus of [
    'PAID',
    'PENDING_VERIFICATION',
    'REFUND_PENDING',
    'REFUNDED',
    'NOT_REQUIRED',
  ] as const)
    assert.deepEqual(orderDeadline({ ...order, paymentStatus }, createdAt), {
      expiresAt,
      remainingSeconds: 0,
    })
  for (const fulfillmentStatus of [
    'CANCELLED',
    'COMPLETED',
    'PROCESSING',
    'FAILED',
  ] as const)
    assert.equal(
      orderDeadline({ ...order, fulfillmentStatus }, createdAt)
        .remainingSeconds,
      0,
    )
  for (const field of [
    'cancelledAt',
    'paidAt',
    'paymentConfirmedAt',
    'fulfilledAt',
  ])
    assert.equal(
      orderDeadline({ ...order, [field]: createdAt }, createdAt)
        .remainingSeconds,
      0,
    )
})
