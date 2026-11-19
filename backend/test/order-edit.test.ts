import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  editAdminOrder,
  editCustomerOrder,
} from '../src/modules/orders/edit-schemas.ts'

test('edit DTOs require a complete form object and a bounded integer expectedVersion', () => {
  const valid = { expectedVersion: 1, formData: {} }
  for (const schema of [editAdminOrder, editCustomerOrder]) {
    assert.deepEqual(schema.parse(valid), valid)
    for (const expectedVersion of [
      undefined,
      null,
      0,
      -1,
      1.5,
      '1',
      2147483648,
    ])
      assert(!schema.safeParse({ ...valid, expectedVersion }).success)
    for (const formData of [undefined, null, [], 'partial'])
      assert(!schema.safeParse({ ...valid, formData }).success)
  }
})
test('CUSTOMER edit rejects price, private notes, ownership and every forged managed field', () => {
  const valid = { expectedVersion: 2, formData: { account: 'updated' } }
  for (const field of [
    'amountFen',
    'priceAdjustmentReason',
    'internalNote',
    'userId',
    'productId',
    'source',
    'hidden',
    'kind',
    'version',
    'paidAt',
    'paymentStatus',
    'fulfillmentStatus',
    'formSchemaSnapshot',
    'servicePeriodCountSnapshot',
    'createdAt',
  ])
    assert(
      !editCustomerOrder.safeParse({ ...valid, [field]: 'forged' }).success,
    )
})
test('ADMIN edit allows optional integer Fen including zero but excludes notes and snapshots', () => {
  const valid = { expectedVersion: 1, formData: {} }
  for (const amountFen of [0, 1, 2147483647])
    assert.equal(
      editAdminOrder.parse({ ...valid, amountFen }).amountFen,
      amountFen,
    )
  for (const amountFen of [null, -1, 0.1, '1', 2147483648])
    assert(!editAdminOrder.safeParse({ ...valid, amountFen }).success)
  for (const field of [
    'internalNote',
    'userId',
    'productId',
    'source',
    'formSchemaSnapshot',
    'paymentStatus',
    'fulfilledAt',
  ])
    assert(!editAdminOrder.safeParse({ ...valid, [field]: 'forged' }).success)
})
test('ADMIN edit reason is trimmed, bounded and nonblank when supplied', () => {
  const valid = { expectedVersion: 1, formData: {}, amountFen: 0 }
  assert.equal(
    editAdminOrder.parse({ ...valid, priceAdjustmentReason: ' gift ' })
      .priceAdjustmentReason,
    'gift',
  )
  for (const priceAdjustmentReason of [null, '', ' ', 'x'.repeat(501)])
    assert(
      !editAdminOrder.safeParse({ ...valid, priceAdjustmentReason }).success,
    )
})
