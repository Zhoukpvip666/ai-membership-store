import { expect, test } from 'vitest'
import type { AdminOrder, Evidence } from '../../../api/orders'
import { orderActions } from './state'
const order: AdminOrder = {
  id: 'order',
  orderNo: 'number',
  version: 1,
  productId: 'product',
  kind: 'INITIAL',
  productTypeSnapshot: 'SUBSCRIPTION',
  productNameSnapshot: 'Frozen',
  productDescriptionSnapshot: null,
  priceSnapshotFen: 1000,
  termSnapshot: 'display',
  servicePeriodUnitSnapshot: 'MONTH',
  servicePeriodCountSnapshot: 1,
  renewalPriceSnapshotFen: 900,
  formSchemaSnapshot: { version: 1, fields: [] },
  formData: {},
  amountFen: 0,
  contactEmailSnapshot: 'customer@example.com',
  targetIdentifier: null,
  paymentStatus: 'NOT_REQUIRED',
  fulfillmentStatus: 'PROCESSING',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  remainingSeconds: 0,
  paidAt: null,
  paymentConfirmedAt: null,
  fulfilledAt: null,
  cancelledAt: null,
  cancellationReason: null,
  internalNote: null,
  customer: {
    id: 'customer',
    username: null,
    adminLabel: null,
    loginEmail: 'customer@example.com',
    notificationEmail: null,
  },
  creator: { source: 'ADMIN', adminId: 'admin', userId: null },
}
const payment: Evidence = {
  id: 'payment',
  orderId: 'order',
  kind: 'PAYMENT',
  amountFen: 1000,
  channel: 'CASH',
  status: 'CONFIRMED',
  occurredAt: '2026-01-01T01:00:00.000Z',
  confirmedAt: '2026-01-01T02:00:00.000Z',
  externalReference: null,
  note: null,
  createdAt: '2026-01-01T01:00:00.000Z',
  updatedAt: '2026-01-01T02:00:00.000Z',
  createdByAdminId: 'admin',
  confirmedByAdminId: 'admin',
}
test('zero orders remain fulfillable after payment deadline but never offer payment/refund', () => {
  const actions = orderActions(
    order,
    [],
    [],
    true,
    Date.parse('2026-02-01T00:00:00Z'),
  )
  expect(actions.fulfill).toBe(true)
  expect(actions.cancel).toBe(true)
  expect(actions.record).toBe(false)
  expect(actions.refund).toBe(false)
  expect(
    orderActions(
      order,
      [{ ...payment, status: 'FAILED', confirmedAt: null }],
      [],
    ).fulfill,
  ).toBe(false)
})
test('paid fulfillment requires exact facts, supported snapshots and no pending/refund attempt', () => {
  const paid = {
    ...order,
    amountFen: 1000,
    paymentStatus: 'PAID' as const,
    paidAt: payment.occurredAt,
    paymentConfirmedAt: payment.confirmedAt,
  }
  expect(orderActions(paid, [payment], []).fulfill).toBe(true)
  expect(
    orderActions(paid, [{ ...payment, occurredAt: 'wrong' }], []).fulfill,
  ).toBe(false)
  expect(
    orderActions(
      paid,
      [
        payment,
        { ...payment, id: 'pending', status: 'PENDING', confirmedAt: null },
      ],
      [],
    ).fulfill,
  ).toBe(false)
  expect(
    orderActions({ ...paid, servicePeriodCountSnapshot: null }, [payment], [])
      .fulfill,
  ).toBe(false)
  expect(orderActions(paid, [payment], [], false).fulfill).toBe(false)
})
test('terminal/unsupported renewal states allow ordinary notes but no lifecycle writes; system notes denied', () => {
  for (const fulfillmentStatus of [
    'COMPLETED',
    'CANCELLED',
    'FAILED',
  ] as const) {
    const actions = orderActions({ ...order, fulfillmentStatus }, [], [])
    expect(actions.note).toBe(true)
    expect(
      actions.cancel || actions.fulfill || actions.record || actions.edit,
    ).toBe(false)
  }
  expect(orderActions({ ...order, kind: 'RENEWAL' }, [], []).fulfill).toBe(
    false,
  )
  expect(
    orderActions(
      {
        ...order,
        creator: { source: 'SYSTEM_RENEWAL', adminId: null, userId: null },
      },
      [],
      [],
    ).note,
  ).toBe(false)
})
