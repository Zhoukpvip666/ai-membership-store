import { expect, test } from 'vitest'
import {
  transactionTimeChoices,
  transactionTimeInput,
} from '../../../backend/src/contracts/transaction-time'

test('Los Angeles rollback exposes both occurrences with seconds and milliseconds intact', () => {
  const zone = 'America/Los_Angeles'
  const wallTime = '2026-11-01T01:30:27.123'
  const earlier = '2026-11-01T08:30:27.123Z'
  const later = '2026-11-01T09:30:27.123Z'
  expect(transactionTimeInput(earlier, zone)).toBe(wallTime)
  expect(transactionTimeInput(later, zone)).toBe(wallTime)
  expect(transactionTimeChoices(wallTime, zone)).toEqual([
    { offset: '-07:00', utc: earlier },
    { offset: '-08:00', utc: later },
  ])
})

test('Lord Howe rollback distinguishes occurrences thirty minutes apart', () => {
  expect(
    transactionTimeChoices('2026-04-05T01:45', 'Australia/Lord_Howe'),
  ).toEqual([
    { offset: '+11:00', utc: '2026-04-04T14:45:00.000Z' },
    { offset: '+10:30', utc: '2026-04-04T15:15:00.000Z' },
  ])
})

test('spring-forward gaps reject actual transaction entry without shifting time', () => {
  expect(() =>
    transactionTimeChoices('2026-03-08T02:30:00.123', 'America/Los_Angeles'),
  ).toThrow('该时区不存在此日期或时间')
  expect(
    transactionTimeChoices('2026-03-08T03:00', 'America/Los_Angeles'),
  ).toEqual([{ offset: '-07:00', utc: '2026-03-08T10:00:00.000Z' }])
})

test('ordinary times have one choice and invalid dates are rejected', () => {
  expect(
    transactionTimeChoices('2026-11-01T08:30:00.1', 'Asia/Shanghai'),
  ).toEqual([{ offset: '+08:00', utc: '2026-11-01T00:30:00.100Z' }])
  expect(() => transactionTimeChoices('2026-02-30T01:00', 'UTC')).toThrow()
  expect(() => transactionTimeChoices('2026-01-01T00:00:60', 'UTC')).toThrow()
})
