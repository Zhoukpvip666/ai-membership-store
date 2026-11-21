import { expect, test } from 'vitest'
import { formatOrderNumber } from './format'

test('order number display groups exactly nine digits and preserves historical formats', () => {
  expect(formatOrderNumber('583024917')).toBe('583 024 917')
  expect(formatOrderNumber('100000000')).toBe('100 000 000')
  for (const historical of [
    'O011a819df01447f6851c48692365ff7f',
    'T21-00001',
    '12345678',
    '1234567890',
    '583 024 917',
  ]) {
    expect(formatOrderNumber(historical)).toBe(historical)
  }
})
