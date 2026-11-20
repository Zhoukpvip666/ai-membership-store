import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listRefunds,
  recordRefund,
  confirmRefund,
  failRefund,
} from '../src/modules/orders/refund-schemas.ts'

const body = {
  expectedVersion: 1,
  amountFen: 1000,
  channel: 'WECHAT',
  occurredAt: '2026-11-19T10:30:00.000Z',
}
test('refund registration requires positive integer Fen and explicit UTC millisecond occurrence', () => {
  for (const channel of ['WECHAT', 'ALIPAY', 'BANK_TRANSFER', 'CASH', 'OTHER'])
    assert(recordRefund.safeParse({ ...body, channel }).success)
  for (const amountFen of [undefined, null, '100', 0, -1, 1.5, 2147483648])
    assert(!recordRefund.safeParse({ ...body, amountFen }).success)
  for (const occurredAt of [
    undefined,
    null,
    'yesterday',
    '2026-02-30T10:30:00.000Z',
    '2026-11-19T10:30:00Z',
    '2026-11-19T10:30:00.000+08:00',
  ])
    assert(!recordRefund.safeParse({ ...body, occurredAt }).success)
  assert(!recordRefund.safeParse({ ...body, channel: 'CARD' }).success)
})
test('refund mutation DTOs reject forged identities/states and invalid versions', () => {
  for (const [schema, input] of [
    [recordRefund, body],
    [confirmRefund, { expectedVersion: 1 }],
    [failRefund, { expectedVersion: 1, reason: 'Bank rejected' }],
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
      'orderId',
      'kind',
      'status',
      'confirmedAt',
      'confirmedByAdminId',
      'version',
      'createdAt',
      'internalNote',
    ])
      assert(!schema.safeParse({ ...input, [field]: 'forged' }).success)
  }
})
test('refund evidence is bounded/trimmed and failure requires a separate nonblank reason', () => {
  const parsed = recordRefund.parse({
    ...body,
    note: ' evidence ',
    externalReference: ' ref ',
  })
  assert.equal(parsed.note, 'evidence')
  assert.equal(parsed.externalReference, 'ref')
  assert(!recordRefund.safeParse({ ...body, note: 'x'.repeat(501) }).success)
  assert(
    !recordRefund.safeParse({ ...body, externalReference: 'x'.repeat(121) })
      .success,
  )
  for (const reason of [undefined, null, '', '  ', 123, 'x'.repeat(501)])
    assert(!failRefund.safeParse({ expectedVersion: 1, reason }).success)
  assert.equal(
    failRefund.parse({ expectedVersion: 1, reason: ' Bank rejected ' }).reason,
    'Bank rejected',
  )
})
test('refund listing has strict bounded pagination with no customer/kind overrides', () => {
  assert.deepEqual(listRefunds.parse({}), { page: 1, pageSize: 20 })
  assert.deepEqual(listRefunds.parse({ page: '2', pageSize: '100' }), {
    page: 2,
    pageSize: 100,
  })
  for (const query of [
    { page: '0' },
    { page: '1.5' },
    { page: '10001' },
    { pageSize: '101' },
    { userId: 'other' },
    { kind: 'PAYMENT' },
  ])
    assert(!listRefunds.safeParse(query).success)
})
