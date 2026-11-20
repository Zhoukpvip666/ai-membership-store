import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordPayment,
  confirmPayment,
  failPayment,
  listPayments,
} from '../src/modules/orders/payment-schemas.ts'

const body = {
  expectedVersion: 1,
  amountFen: 1000,
  channel: 'CASH',
  occurredAt: '2026-11-19T10:30:00.000Z',
}
test('offline payment strict registration validates Fen, all channels and UTC millisecond timestamps', () => {
  for (const channel of ['WECHAT', 'ALIPAY', 'BANK_TRANSFER', 'CASH', 'OTHER'])
    assert(recordPayment.safeParse({ ...body, channel }).success)
  for (const amountFen of [undefined, null, '100', 0, -1, 1.5, 2147483648])
    assert(!recordPayment.safeParse({ ...body, amountFen }).success)
  for (const occurredAt of [
    undefined,
    null,
    'yesterday',
    '2026-02-30T10:30:00.000Z',
    '2026-11-19T10:30:00',
    '2026-11-19T10:30:00Z',
    '2026-11-19T10:30:00.000+08:00',
  ])
    assert(!recordPayment.safeParse({ ...body, occurredAt }).success)
  assert(!recordPayment.safeParse({ ...body, channel: 'CARD' }).success)
})
test('payment DTOs reject forged state/actors and require bounded integer versions', () => {
  for (const [schema, input] of [
    [recordPayment, body],
    [confirmPayment, { expectedVersion: 1 }],
    [failPayment, { expectedVersion: 1, reason: 'Not received' }],
  ] as const) {
    for (const expectedVersion of [
      undefined,
      null,
      '1',
      0,
      -1,
      1.5,
      2147483648,
    ])
      assert(!schema.safeParse({ ...input, expectedVersion }).success)
    for (const field of [
      'actorId',
      'userId',
      'orderId',
      'status',
      'paidAt',
      'confirmedAt',
      'confirmedByAdminId',
      'internalNote',
    ])
      assert(!schema.safeParse({ ...input, [field]: 'forged' }).success)
  }
})
test('payment notes/references are trimmed and failure requires a separate bounded reason', () => {
  assert.equal(
    recordPayment.parse({
      ...body,
      note: ' original ',
      externalReference: ' ref ',
    }).note,
    'original',
  )
  assert.equal(
    recordPayment.parse({ ...body, externalReference: ' ref ' })
      .externalReference,
    'ref',
  )
  assert(!recordPayment.safeParse({ ...body, note: 'x'.repeat(501) }).success)
  assert(
    !recordPayment.safeParse({ ...body, externalReference: 'x'.repeat(121) })
      .success,
  )
  for (const reason of [undefined, null, '', '  ', 123, 'x'.repeat(501)])
    assert(!failPayment.safeParse({ expectedVersion: 1, reason }).success)
  assert.equal(
    failPayment.parse({ expectedVersion: 1, reason: ' No receipt ' }).reason,
    'No receipt',
  )
})
test('payment list pagination is strict and bounded', () => {
  assert.deepEqual(listPayments.parse({}), { page: 1, pageSize: 20 })
  assert.deepEqual(listPayments.parse({ page: '2', pageSize: '100' }), {
    page: 2,
    pageSize: 100,
  })
  for (const query of [
    { page: '0' },
    { page: '1.5' },
    { page: '10001' },
    { pageSize: '101' },
    { userId: 'other' },
    { kind: 'REFUND' },
  ])
    assert(!listPayments.safeParse(query).success)
})
