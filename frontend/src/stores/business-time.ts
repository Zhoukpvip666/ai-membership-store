export function businessInput(iso: string, timezone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  )
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}
export function businessUtc(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('请填写完整日期和时间')
  const desired = Date.parse(value + ':00.000Z')
  let guess = desired
  for (let n = 0; n < 4; n++) {
    const local = Date.parse(
      businessInput(new Date(guess).toISOString(), timezone) + ':00.000Z',
    )
    guess += desired - local
  }
  const result = new Date(guess).toISOString()
  if (businessInput(result, timezone) !== value)
    throw new Error('该时区不存在此日期或时间，请重新选择')
  return result
}
