import { Temporal } from '@js-temporal/polyfill'

export function transactionTimeInput(iso: string, timeZone: string) {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
}

export function transactionTimeChoices(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value))
    throw new Error('请填写完整日期和时间')

  let local: Temporal.PlainDateTime
  try {
    local = Temporal.PlainDateTime.from(value)
  } catch {
    throw new Error('请填写有效的日期和时间')
  }

  const earlier = local.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
  if (!earlier.toPlainDateTime().equals(local))
    throw new Error('该时区不存在此日期或时间，请重新选择')

  const later = local.toZonedDateTime(timeZone, { disambiguation: 'later' })
  const candidates = earlier.equals(later) ? [earlier] : [earlier, later]
  return candidates.map((candidate) => ({
    offset: candidate.offset,
    utc: candidate.toInstant().toString({ smallestUnit: 'millisecond' }),
  }))
}
