import type { PublicProduct } from '../api/catalog'

const units = { DAY: '天', MONTH: '个月', YEAR: '年' } as const

export function productPeriod(
  product: Pick<
    PublicProduct,
    'servicePeriodUnit' | 'servicePeriodCount' | 'termLabel'
  >,
) {
  const { servicePeriodUnit: unit, servicePeriodCount: count } = product
  const label = product.termLabel.trim()
  if (!unit || !count) return { text: label }

  const text = count + ' ' + units[unit]
  const comparable = (value: string) =>
    value.normalize('NFKC').replace(/\s/g, '')
  return { text, note: comparable(label) === comparable(text) ? '' : label }
}
