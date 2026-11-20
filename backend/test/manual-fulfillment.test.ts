import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fulfillOrder } from '../src/modules/orders/fulfill-schemas.ts'
import { canonicalBillingTimezone } from '../src/modules/orders/service-period.ts'

test('fulfillment requires a bounded version and a trimmed optional note', () => {
  assert.deepEqual(fulfillOrder.parse({ expectedVersion: 1 }), {
    expectedVersion: 1,
    fulfillmentNote: null,
  })
  assert.equal(
    fulfillOrder.parse({ expectedVersion: 1, fulfillmentNote: '   ' })
      .fulfillmentNote,
    null,
  )
  assert.equal(
    fulfillOrder.parse({ expectedVersion: 1, fulfillmentNote: ' delivered ' })
      .fulfillmentNote,
    'delivered',
  )
  for (const expectedVersion of [undefined, null, '1', 0, -1, 1.5, 2147483648])
    assert(!fulfillOrder.safeParse({ expectedVersion }).success)
  for (const fulfillmentNote of [null, 123, 'x'.repeat(501)])
    assert(
      !fulfillOrder.safeParse({ expectedVersion: 1, fulfillmentNote }).success,
    )
})
test('fulfillment cannot accept forged identity, subscription, date, period or state fields', () => {
  for (const key of [
    'actorId',
    'source',
    'subscriptionId',
    'fulfilledAt',
    'expiresAt',
    'servicePeriodCount',
    'billingTimezone',
    'paymentStatus',
    'version',
    'internalNote',
    'formData',
  ])
    assert(
      !fulfillOrder.safeParse({ expectedVersion: 1, [key]: 'forged' }).success,
    )
})
test('billing timezone canonicalization rejects invalid/offset zones without fallback', () => {
  assert.equal(canonicalBillingTimezone('US/Eastern'), 'America/New_York')
  assert.equal(canonicalBillingTimezone('Etc/UTC'), 'UTC')
  for (const value of ['', 'Invalid/Zone', '+08:00'])
    assert.throws(() => canonicalBillingTimezone(value), RangeError)
})
