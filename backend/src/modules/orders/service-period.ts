import { Temporal } from '@js-temporal/polyfill'

// Promoted unchanged from the approved D86 dependency preflight.
export function resolveLocal(
  local: Temporal.PlainDateTime,
  timeZone: string,
): Temporal.ZonedDateTime {
  const earlier = local.toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  })
  if (earlier.toPlainDateTime().equals(local)) return earlier

  // A gap shifts "earlier" backwards. Use the actual transition boundary,
  // rather than "later", which shifts the requested wall time past the gap.
  const transition = earlier.getTimeZoneTransition('next')
  if (
    !transition ||
    Temporal.PlainDateTime.compare(
      transition.subtract({ nanoseconds: 1 }).toPlainDateTime(),
      local,
    ) >= 0 ||
    Temporal.PlainDateTime.compare(transition.toPlainDateTime(), local) <= 0
  )
    throw new RangeError('No timezone transition brackets the local-time gap')
  return transition
}

export function periodEnd(
  anchorUtc: string,
  timeZone: string,
  unit: 'DAY' | 'MONTH' | 'YEAR',
  count: number,
): Temporal.Instant {
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new RangeError('Period count must be a positive safe integer')
  const anchor = Temporal.Instant.from(anchorUtc)
  const local = anchor.toZonedDateTimeISO(timeZone).toPlainDateTime()
  const end =
    unit === 'DAY'
      ? anchor.add({ hours: count * 24 })
      : resolveLocal(
          local.add(unit === 'MONTH' ? { months: count } : { years: count }, {
            overflow: 'constrain',
          }),
          timeZone,
        ).toInstant()
  if (Temporal.Instant.compare(end, anchor) <= 0)
    throw new RangeError('Period end must follow its original anchor')
  return end
}

const supported = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
  'Etc/GMT',
  ...Array.from({ length: 15 }, (_, offset) => `Etc/GMT-${offset}`),
  ...Array.from({ length: 13 }, (_, offset) => `Etc/GMT+${offset}`),
])
export function canonicalBillingTimezone(value: string): string {
  if (!value || /^[+-]/.test(value))
    throw new RangeError('An IANA timezone is required')
  const canonical = new Intl.DateTimeFormat('en', {
    timeZone: value,
  }).resolvedOptions().timeZone
  if (!supported.has(canonical))
    throw new RangeError('Unsupported canonical IANA timezone')
  return canonical
}
