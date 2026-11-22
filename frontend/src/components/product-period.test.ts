import { expect, test } from 'vitest'
import { productPeriod } from './product-period'

test('uses the structured period once even when the display label uses different spacing', () => {
  expect(
    productPeriod({
      servicePeriodCount: 1,
      servicePeriodUnit: 'MONTH',
      termLabel: ' １个月 ',
    }),
  ).toEqual({ text: '1 个月', note: '' })
})

test('keeps a distinct period note and uses the configured fallback for older products', () => {
  expect(
    productPeriod({
      servicePeriodCount: 30,
      servicePeriodUnit: 'DAY',
      termLabel: '自开通日开始计算',
    }),
  ).toEqual({ text: '30 天', note: '自开通日开始计算' })
  expect(
    productPeriod({
      servicePeriodCount: null,
      servicePeriodUnit: null,
      termLabel: '一次性',
    }),
  ).toEqual({ text: '一次性' })
})
