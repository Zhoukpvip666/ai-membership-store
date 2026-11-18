import { test } from 'vitest'
import assert from 'node:assert/strict'
import { adminName } from './user-name'
import { businessInput, businessUtc } from './business-time'
test('admin naming prefers private label then username then email prefix', () => {
  assert.equal(
    adminName({
      adminLabel: 'Private',
      username: 'Public',
      loginEmail: 'fallback@example.com',
    }),
    'Private',
  )
  assert.equal(
    adminName({
      adminLabel: null,
      username: 'Public',
      loginEmail: 'fallback@example.com',
    }),
    'Public',
  )
  assert.equal(
    adminName({ username: null, loginEmail: 'fallback@example.com' }),
    'fallback',
  )
})
test('business time converts UTC and Shanghai independently of browser/system timezone', () => {
  assert.equal(
    businessInput('2026-11-17T00:00:00.000Z', 'Asia/Shanghai'),
    '2026-11-17T08:00',
  )
  assert.equal(
    businessUtc('2026-11-17T08:00', 'Asia/Shanghai'),
    '2026-11-17T00:00:00.000Z',
  )
  assert.equal(
    businessUtc('2026-11-17T08:00', 'UTC'),
    '2026-11-17T08:00:00.000Z',
  )
  assert.throws(() => businessUtc('2026-03-08T02:30', 'America/Los_Angeles'))
  assert.throws(() => businessUtc('2026-02-30T01:00', 'UTC'))
})
