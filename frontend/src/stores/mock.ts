import { reactive } from 'vue'
import { createFixtures } from './fixtures'

export const CURRENT_USER = 'u1'

export function createMockStore() {
  const state = reactive({
    ...createFixtures(),
    signedIn: true,
    notificationEmail: 'lin@example.com',
    settings: {
      name: 'AI 会员商店',
      ownerEmail: 'owner@example.com',
      notifyEmail: true,
      notifyExpiry: true,
      timezone: 'Asia/Shanghai',
    },
  })
  const timestamp = () => new Date().toISOString()
  const customer = (id: string) =>
    state.customers.find((user) => user.id === id)
  const product = (id: string) => state.products.find((item) => item.id === id)
  const order = (id: string) => {
    const value = state.orders.find((item) => item.id === id)
    if (!value) throw new Error('订单不存在')
    return value
  }
  function complete(id: string) {
    const item = order(id)
    if (
      !item.paid ||
      item.status !== 'PENDING' ||
      item.refund === 'PROCESSING' ||
      item.refund === 'SUCCESS'
    )
      throw new Error('当前订单不可完成')
    item.status = 'COMPLETED'
    item.fulfillment = 'COMPLETED'
    item.timeline.push({
      label: '模拟确认服务完成 · 未发送邮件',
      at: timestamp(),
    })
    // Prototype only: no entitlement creation or inferred expiry changes.
  }
  function requestRefund(id: string) {
    const item = order(id)
    if (
      !item.paid ||
      item.status !== 'PENDING' ||
      !['NONE', 'FAILED'].includes(item.refund)
    )
      throw new Error('当前订单不可申请模拟退款')
    item.refund = 'PROCESSING'
    item.timeline.push({
      label: '模拟退款申请 · 等待模拟结果',
      at: timestamp(),
    })
  }
  function resolveRefund(id: string, success: boolean) {
    const item = order(id)
    if (item.refund !== 'PROCESSING') throw new Error('退款不在处理中')
    item.refund = success ? 'SUCCESS' : 'FAILED'
    if (success) {
      item.status = 'REFUNDED'
      item.fulfillment = 'CANCELLED'
      item.refundedAt = timestamp()
    }
    item.timeline.push({
      label: success
        ? '模拟退款成功 · 履约已取消 · 无真实资金变动'
        : '模拟退款失败 · 可重试',
      at: timestamp(),
    })
  }
  return {
    state,
    customer,
    product,
    complete,
    requestRefund,
    resolveRefund,
  }
}
export const mock = createMockStore()
