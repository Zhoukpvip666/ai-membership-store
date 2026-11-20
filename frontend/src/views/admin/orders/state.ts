import type { AdminOrder, Evidence } from '../../../api/orders'
export const paymentLabels = {
  UNPAID: '待付款',
  PENDING_VERIFICATION: '待核实付款',
  PAID: '已付款',
  REFUND_PENDING: '待退款',
  REFUNDED: '已退款',
  NOT_REQUIRED: '无需付款',
}
export const fulfillmentLabels = {
  NOT_STARTED: '未开始',
  PROCESSING: '履约处理中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
}
export const kindLabels = {
  INITIAL: '首次订阅',
  ONE_TIME: '一次性',
  RENEWAL: '续费',
}
export const channelLabels = {
  WECHAT: '微信',
  ALIPAY: '支付宝',
  BANK_TRANSFER: '银行转账',
  CASH: '现金',
  OTHER: '其他',
}
export function orderActions(
  o: AdminOrder,
  payments: Evidence[],
  refunds: Evidence[],
  complete = true,
  now = Date.now(),
) {
  const ordinary =
    ['USER', 'ADMIN'].includes(o.creator.source ?? '') &&
    ['INITIAL', 'ONE_TIME'].includes(o.kind)
  const deadline = now < Date.parse(o.expiresAt)
  const confirmed = payments.filter(
    (p) => p.status === 'CONFIRMED' || p.confirmedAt,
  )
  const noFacts =
    !o.paidAt &&
    !o.paymentConfirmedAt &&
    !o.cancelledAt &&
    !o.fulfilledAt &&
    confirmed.length === 0
  const unpaid =
    ordinary &&
    o.fulfillmentStatus === 'NOT_STARTED' &&
    ['UNPAID', 'PENDING_VERIFICATION'].includes(o.paymentStatus) &&
    noFacts &&
    o.amountFen > 0
  const receipt = confirmed[0]
  const paid =
    ordinary &&
    o.fulfillmentStatus === 'PROCESSING' &&
    o.paymentStatus === 'PAID' &&
    !!o.paidAt &&
    !!o.paymentConfirmedAt &&
    !o.cancelledAt &&
    !o.fulfilledAt &&
    confirmed.length === 1 &&
    receipt?.status === 'CONFIRMED' &&
    receipt.amountFen === o.amountFen &&
    receipt.occurredAt === o.paidAt &&
    receipt.confirmedAt === o.paymentConfirmedAt &&
    Date.parse(o.paidAt) <= Date.parse(o.paymentConfirmedAt)
  const zero =
    ordinary &&
    o.amountFen === 0 &&
    o.paymentStatus === 'NOT_REQUIRED' &&
    o.fulfillmentStatus === 'PROCESSING' &&
    noFacts &&
    payments.length === 0 &&
    refunds.length === 0
  const refund =
    ordinary &&
    o.fulfillmentStatus === 'CANCELLED' &&
    o.paymentStatus === 'REFUND_PENDING' &&
    !!o.cancelledAt &&
    !!o.paidAt &&
    !!o.paymentConfirmedAt &&
    !o.fulfilledAt &&
    o.amountFen > 0 &&
    confirmed.length === 1 &&
    receipt?.status === 'CONFIRMED' &&
    receipt.amountFen === o.amountFen &&
    receipt.occurredAt === o.paidAt &&
    receipt.confirmedAt === o.paymentConfirmedAt
  return {
    note: ['USER', 'ADMIN'].includes(o.creator.source ?? ''),
    edit:
      complete &&
      unpaid &&
      deadline &&
      o.paymentStatus === 'UNPAID' &&
      !!o.formSchemaSnapshot,
    record: complete && unpaid && deadline,
    cancel: complete && (unpaid || paid || zero),
    fulfill:
      complete &&
      !o.cancellationReason &&
      refunds.length === 0 &&
      !payments.some((p) => p.status === 'PENDING') &&
      ((o.kind === 'ONE_TIME' && o.productTypeSnapshot === 'ONE_TIME') ||
        (o.kind === 'INITIAL' &&
          o.productTypeSnapshot === 'SUBSCRIPTION' &&
          !!o.servicePeriodUnitSnapshot &&
          Number(o.servicePeriodCountSnapshot) > 0 &&
          o.renewalPriceSnapshotFen !== null)) &&
      (paid || zero),
    refund: complete && refund && !refunds.some((r) => r.status !== 'FAILED'),
    pendingPayment: complete && unpaid && deadline,
    pendingRefund: complete && refund,
  }
}
export const businessDate = (value: string | null, timezone: string) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'short',
        timeStyle: 'medium',
        hour12: false,
      }).format(new Date(value))
    : '—'
