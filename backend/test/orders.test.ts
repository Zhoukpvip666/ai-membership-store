import { test } from 'node:test'
import assert from 'node:assert/strict'
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
