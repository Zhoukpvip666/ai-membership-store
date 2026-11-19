import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createAdminOrder,
  createCustomerOrder,
  creationKey,
} from '../src/modules/orders/create-schemas.ts'
import { creationForm } from '../src/modules/orders/create-form.ts'

test('creation DTOs are strict, separate identities/prices, and require explicit integer Fen', () => {
  const input = { productId: randomUUID(), formData: {} }
  assert.deepEqual(createCustomerOrder.parse(input), input)
  for (const field of [
    'userId',
    'amountFen',
    'source',
    'version',
    'hidden',
    'internalNote',
    'paymentStatus',
  ])
    assert(
      !createCustomerOrder.safeParse({ ...input, [field]: 'forged' }).success,
    )
  const admin = { ...input, userId: randomUUID(), amountFen: 0 }
  assert.equal(createAdminOrder.parse(admin).internalNote, null)
  for (const amountFen of [undefined, null, '100', -1, 1.5, 2147483648])
    assert(!createAdminOrder.safeParse({ ...admin, amountFen }).success)
  for (const priceAdjustmentReason of ['', '   ', 'x'.repeat(501)])
    assert(
      !createAdminOrder.safeParse({ ...admin, priceAdjustmentReason }).success,
    )
  assert.equal(
    createAdminOrder.parse({ ...admin, priceAdjustmentReason: ' discount ' })
      .priceAdjustmentReason,
    'discount',
  )
})

test('required idempotency key follows existing syntax without trimming or storing raw keys', () => {
  for (const key of [undefined, '', ' ', 'a,b', 'a\nb', 'x'.repeat(129)])
    assert.throws(() => creationKey(key))
  assert.equal(creationKey('a.b:c-d_1'), 'a.b:c-d_1')
})

test('order forms reuse canonical validation and reject explicit credential fields/values', () => {
  const schema = {
    version: 1,
    fields: [{ id: 'account', type: 'text', label: '账号', required: true }],
  }
  assert.deepEqual(creationForm(schema, { account: 'plain-account' }), {
    account: 'plain-account',
  })
  for (const input of [
    {},
    { account: '' },
    { account: 12 },
    { account: 'ok', extra: 'unknown' },
    { account: 'password=secret' },
  ])
    assert.throws(() => creationForm(schema, input))
  for (const label of ['Password', 'access_token', '验证码', '恢复码'])
    assert.throws(() =>
      creationForm(
        { ...schema, fields: [{ ...schema.fields[0], label }] },
        { account: 'never persisted' },
      ),
    )
})
