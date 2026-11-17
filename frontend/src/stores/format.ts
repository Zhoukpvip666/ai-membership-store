import type { Order } from '../types'
export const money = (fen: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(fen / 100)
export function parsePrice(input: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(input.trim()))
    throw new Error('价格需为最多两位小数的正数')
  const [whole, fraction = ''] = input.trim().split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
export const date = (value: string, timezone = 'Asia/Shanghai') =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
export const mask = (value: string) => {
  const [name, domain] = value.split('@')
  return domain
    ? name!.slice(0, 2) + '***@' + domain
    : value.slice(0, 2) + '***'
}
export const orderLabels = {
  PENDING: '待发货',
  COMPLETED: '已完成',
  REFUNDED: '已退款',
}
export const subscriptionLabels = {
  ACTIVE: '有效',
  EXPIRED: '已过期',
  TERMINATED: '已终止',
}
export const refundLabels = {
  NONE: '未申请',
  PROCESSING: '处理中',
  SUCCESS: '成功',
  FAILED: '失败',
}
export function overview(orders: Order[], timezone: string, now = new Date()) {
  const key = (input: string | Date) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(input))
  const today = key(now)
  const net = (prefix: string) =>
    orders.reduce(
      (sum, o) =>
        sum +
        (o.paid && o.verifiedAt && key(o.verifiedAt).startsWith(prefix)
          ? o.amountFen
          : 0) -
        (o.refund === 'SUCCESS' &&
        o.refundedAt &&
        key(o.refundedAt).startsWith(prefix)
          ? o.amountFen
          : 0),
      0,
    )
  return {
    today: net(today),
    month: net(today.slice(0, 7)),
    total: orders.length,
    pending: orders.filter((o) => o.status === 'PENDING').length,
  }
}
