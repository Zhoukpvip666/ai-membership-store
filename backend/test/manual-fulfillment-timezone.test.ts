import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Temporal } from '@js-temporal/polyfill'

import {
  resolveLocal,
  periodEnd,
} from '../src/modules/orders/service-period.ts'

function utc(value: Temporal.Instant | Temporal.ZonedDateTime): string {
  const instant =
    value instanceof Temporal.ZonedDateTime ? value.toInstant() : value
  return instant.toString({ smallestUnit: 'millisecond' })
}

const newYork = 'America/New_York'
const lordHowe = 'Australia/Lord_Howe'

test('ESM named import works without installing or relying on globalThis.Temporal', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'
       const before = globalThis.Temporal
       const { Temporal } = await import('@js-temporal/polyfill')
       assert.equal(typeof Temporal.ZonedDateTime.prototype.getTimeZoneTransition, 'function')
       assert.equal(globalThis.Temporal, before)`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
})

test('D86 NYC gap resolves 02:30 to the first valid instant, not later disambiguation', () => {
  const local = Temporal.PlainDateTime.from('2026-03-08T02:30')
  const resolved = resolveLocal(local, newYork)
  assert.equal(utc(resolved), '2026-03-08T07:00:00.000Z')
  assert.equal(resolved.toPlainDateTime().toString(), '2026-03-08T03:00:00')
  const later = local.toZonedDateTime(newYork, { disambiguation: 'later' })
  assert.equal(utc(later), '2026-03-08T07:30:00.000Z')
  assert.notEqual(utc(resolved), utc(later))
})

test('getTimeZoneTransition identifies the exact NYC gap boundary and adjacent offsets', () => {
  const before = Temporal.Instant.from(
    '2026-03-08T06:59:59.999Z',
  ).toZonedDateTimeISO(newYork)
  const transition = before.getTimeZoneTransition('next')
  assert(transition)
  assert.equal(utc(transition), '2026-03-08T07:00:00.000Z')
  assert.equal(transition.offset, '-04:00')
  const lastInvalidBoundary = transition.subtract({ nanoseconds: 1 })
  assert.equal(lastInvalidBoundary.offset, '-05:00')
  assert.equal(
    lastInvalidBoundary.toPlainDateTime().toString(),
    '2026-03-08T01:59:59.999999999',
  )
  assert.equal(transition.toPlainDateTime().toString(), '2026-03-08T03:00:00')
  assert.equal(
    transition.add({ nanoseconds: 1 }).getTimeZoneTransition('previous')
      ?.epochNanoseconds,
    transition.epochNanoseconds,
  )
})

test('gap resolution uses the first valid instant even when input contains milliseconds', () => {
  for (const time of [
    '02:00:00',
    '02:00:00.001',
    '02:30:00.123',
    '02:59:59.999',
  ])
    assert.equal(
      utc(
        resolveLocal(
          Temporal.PlainDateTime.from(`2026-03-08T${time}`),
          newYork,
        ),
      ),
      '2026-03-08T07:00:00.000Z',
    )
})

test('D86 NYC fold selects the earlier offset and first occurrence of 01:30', () => {
  const local = Temporal.PlainDateTime.from('2026-11-01T01:30')
  const earlier = resolveLocal(local, newYork)
  assert.equal(utc(earlier), '2026-11-01T05:30:00.000Z')
  assert.equal(earlier.offset, '-04:00')
  assert(earlier.toPlainDateTime().equals(local))
  const later = local.toZonedDateTime(newYork, { disambiguation: 'later' })
  assert.equal(utc(later), '2026-11-01T06:30:00.000Z')
  assert.equal(later.offset, '-05:00')
  assert(later.toPlainDateTime().equals(local))
  assert(Temporal.ZonedDateTime.compare(earlier, later) < 0)
})

test('getTimeZoneTransition identifies the NYC fold boundary without selecting its later occurrence', () => {
  const local = Temporal.PlainDateTime.from('2026-11-01T01:30')
  const earlier = resolveLocal(local, newYork)
  const transition = earlier.getTimeZoneTransition('next')
  assert(transition)
  assert.equal(utc(transition), '2026-11-01T06:00:00.000Z')
  assert.equal(transition.offset, '-05:00')
  assert.equal(transition.toPlainDateTime().toString(), '2026-11-01T01:00:00')
  assert.equal(transition.subtract({ nanoseconds: 1 }).offset, '-04:00')
  assert.equal(
    transition.subtract({ nanoseconds: 1 }).toPlainDateTime().toString(),
    '2026-11-01T01:59:59.999999999',
  )
  assert(earlier.epochNanoseconds < transition.epochNanoseconds)
  assert(
    local.toZonedDateTime(newYork, { disambiguation: 'later' })
      .epochNanoseconds > transition.epochNanoseconds,
  )
})

test('valid NYC wall times and exact gap/fold edges are unchanged', () => {
  for (const [local, expected] of [
    ['2026-02-15T09:10:11.123', '2026-02-15T14:10:11.123Z'],
    ['2026-03-08T01:59:59.999', '2026-03-08T06:59:59.999Z'],
    ['2026-03-08T03:00:00', '2026-03-08T07:00:00.000Z'],
    ['2026-11-01T00:59:59.999', '2026-11-01T04:59:59.999Z'],
    ['2026-11-01T02:00:00', '2026-11-01T07:00:00.000Z'],
  ]) {
    const plain = Temporal.PlainDateTime.from(local)
    const resolved = resolveLocal(plain, newYork)
    assert.equal(utc(resolved), expected)
    assert(resolved.toPlainDateTime().equals(plain))
  }
})

test('UTC and a non-DST timezone preserve wall time and have no next transition', () => {
  for (const [zone, expected] of [
    ['UTC', '2026-03-08T02:30:00.123Z'],
    ['Asia/Shanghai', '2026-03-07T18:30:00.123Z'],
  ]) {
    const plain = Temporal.PlainDateTime.from('2026-03-08T02:30:00.123')
    const resolved = resolveLocal(plain, zone)
    assert.equal(utc(resolved), expected)
    assert(resolved.toPlainDateTime().equals(plain))
    assert.equal(resolved.getTimeZoneTransition('next'), null)
  }
})

test('a 30-minute Lord Howe gap resolves to its transition, not a one-hour assumption', () => {
  const local = Temporal.PlainDateTime.from('2026-10-04T02:15:00.123')
  const resolved = resolveLocal(local, lordHowe)
  assert.equal(utc(resolved), '2026-10-03T15:30:00.000Z')
  assert.equal(resolved.toPlainDateTime().toString(), '2026-10-04T02:30:00')
  assert.equal(resolved.offset, '+11:00')
  assert.equal(resolved.subtract({ nanoseconds: 1 }).offset, '+10:30')
  assert.equal(
    resolved.offsetNanoseconds -
      resolved.subtract({ nanoseconds: 1 }).offsetNanoseconds,
    30 * 60 * 1e9,
  )
  assert.equal(
    utc(local.toZonedDateTime(lordHowe, { disambiguation: 'later' })),
    '2026-10-03T15:45:00.123Z',
  )
})

test('a 30-minute Lord Howe fold selects the earlier offset and verifies the transition', () => {
  const local = Temporal.PlainDateTime.from('2026-04-05T01:45:00.123')
  const earlier = resolveLocal(local, lordHowe)
  const later = local.toZonedDateTime(lordHowe, { disambiguation: 'later' })
  assert.equal(utc(earlier), '2026-04-04T14:45:00.123Z')
  assert.equal(utc(later), '2026-04-04T15:15:00.123Z')
  assert.equal(
    later.epochMilliseconds - earlier.epochMilliseconds,
    30 * 60 * 1000,
  )
  const transition = earlier.getTimeZoneTransition('next')
  assert(transition)
  assert.equal(utc(transition), '2026-04-04T15:00:00.000Z')
  assert.equal(transition.toPlainDateTime().toString(), '2026-04-05T01:30:00')
  assert.equal(transition.offset, '+10:30')
  assert.equal(transition.subtract({ nanoseconds: 1 }).offset, '+11:00')
})

test('MONTH always uses the original January 31 anchor across clamps and DST', () => {
  const anchor = '2026-01-31T15:20:30.123Z'
  for (const [count, expected] of [
    [1, '2026-02-28T15:20:30.123Z'],
    [2, '2026-03-31T14:20:30.123Z'],
    [3, '2026-04-30T14:20:30.123Z'],
    [4, '2026-05-31T14:20:30.123Z'],
  ] as const)
    assert.equal(utc(periodEnd(anchor, newYork, 'MONTH', count)), expected)
})

test('MONTH clamps to February 29 in a leap year and restores March 31', () => {
  const anchor = '2028-01-31T04:05:06.789Z'
  assert.equal(
    utc(periodEnd(anchor, 'Asia/Shanghai', 'MONTH', 1)),
    '2028-02-29T04:05:06.789Z',
  )
  assert.equal(
    utc(periodEnd(anchor, 'Asia/Shanghai', 'MONTH', 2)),
    '2028-03-31T04:05:06.789Z',
  )
})

test('YEAR retains the February 29 anchor through non-leap and leap target years', () => {
  const anchor = '2024-02-29T04:05:06.789Z'
  assert.equal(
    utc(periodEnd(anchor, 'Asia/Shanghai', 'YEAR', 1)),
    '2025-02-28T04:05:06.789Z',
  )
  assert.equal(
    utc(periodEnd(anchor, 'Asia/Shanghai', 'YEAR', 4)),
    '2028-02-29T04:05:06.789Z',
  )
})

test('MONTH and YEAR arithmetic apply D86 gap/fold resolution after calendar addition', () => {
  for (const [anchor, unit, expected] of [
    ['2026-02-08T07:30:00.123Z', 'MONTH', '2026-03-08T07:00:00.000Z'],
    ['2025-03-08T07:30:00.123Z', 'YEAR', '2026-03-08T07:00:00.000Z'],
    ['2026-10-01T05:30:00.123Z', 'MONTH', '2026-11-01T05:30:00.123Z'],
    ['2025-11-01T05:30:00.123Z', 'YEAR', '2026-11-01T05:30:00.123Z'],
  ] as const)
    assert.equal(utc(periodEnd(anchor, newYork, unit, 1)), expected)
})

test('DAY is exactly 24 hours across both DST transitions and preserves milliseconds', () => {
  for (const [anchor, expected, localHour] of [
    ['2026-03-07T17:00:00.123Z', '2026-03-08T17:00:00.123Z', 13],
    ['2026-10-31T16:00:00.123Z', '2026-11-01T16:00:00.123Z', 11],
  ] as const) {
    const end = periodEnd(anchor, newYork, 'DAY', 1)
    assert.equal(utc(end), expected)
    assert.equal(
      end.epochMilliseconds - Temporal.Instant.from(anchor).epochMilliseconds,
      24 * 60 * 60 * 1000,
    )
    assert.equal(end.toZonedDateTimeISO(newYork).hour, localHour)
  }
})

test('multi-unit periods use their explicit counts rather than display labels', () => {
  const anchor = '2026-01-31T04:05:06.789Z'
  for (const [unit, count, expected] of [
    ['DAY', 7, '2026-02-07T04:05:06.789Z'],
    ['MONTH', 3, '2026-04-30T04:05:06.789Z'],
    ['MONTH', 12, '2027-01-31T04:05:06.789Z'],
    ['YEAR', 2, '2028-01-31T04:05:06.789Z'],
  ] as const)
    assert.equal(utc(periodEnd(anchor, 'Asia/Shanghai', unit, count)), expected)
})

test('millisecond precision survives valid wall time and the earlier fold occurrence', () => {
  for (const [local, expected] of [
    ['2026-06-15T12:34:56.789', '2026-06-15T16:34:56.789Z'],
    ['2026-11-01T01:30:00.123', '2026-11-01T05:30:00.123Z'],
  ])
    assert.equal(
      utc(resolveLocal(Temporal.PlainDateTime.from(local), newYork)),
      expected,
    )
})

test('invalid timezones are rejected without a UTC or host-timezone fallback', () => {
  for (const zone of ['Invalid/Timezone', 'Mars/Olympus_Mons', '', '+25:00']) {
    assert.throws(
      () => resolveLocal(Temporal.PlainDateTime.from('2026-03-08T02:30'), zone),
      RangeError,
    )
    for (const unit of ['DAY', 'MONTH', 'YEAR'] as const)
      assert.throws(
        () => periodEnd('2026-01-31T00:00:00.123Z', zone, unit, 1),
        RangeError,
      )
  }
})

test('invalid period counts and unsupported date ranges are rejected', () => {
  for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => periodEnd('2026-01-31T00:00:00.123Z', newYork, 'MONTH', count),
      RangeError,
    )
  assert.throws(
    () => periodEnd('2026-01-31T00:00:00.123Z', newYork, 'YEAR', 2147483647),
    RangeError,
  )
})
