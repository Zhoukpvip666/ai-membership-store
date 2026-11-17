import { reactive } from 'vue'
import { createFixtures } from './fixtures'
import type { Order, Product, Subscription } from '../types'

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
  const canRenew = (sub: Subscription) =>
    sub.status !== 'TERMINATED' &&
    Boolean(product(sub.productId)?.renewalEnabled)
  function saveProduct(input: Omit<Product, 'id'>, id?: string) {
    if (
      !input.name.trim() ||
      !Number.isSafeInteger(input.priceFen) ||
      input.priceFen <= 0
    )
      throw new Error('请填写商品名称与有效售价')
    if (
      input.type === 'SUBSCRIPTION' &&
      (!input.term.trim() ||
        !Number.isSafeInteger(input.renewalPriceFen) ||
        (input.renewalPriceFen ?? 0) <= 0)
    )
      throw new Error('订阅商品需填写周期和续费价格')
    const record = {
      ...input,
      name: input.name.trim(),
      id: id ?? crypto.randomUUID(),
    }
    if (record.type === 'ONE_TIME') {
      record.renewalPriceFen = null
      record.renewalEnabled = false
      record.term = '单次服务'
    }
    if (id) {
      const index = state.products.findIndex((p) => p.id === id)
      if (index < 0) throw new Error('商品不存在')
      state.products[index] = record
    } else state.products.push(record)
  }
  function checkout(
    productId: string,
    email: string,
    target: string,
    subscriptionId?: string,
  ) {
    if (!state.signedIn) throw new Error('请先进入演示账户')
    const item = product(productId)
    const subscription = subscriptionId
      ? state.subscriptions.find(
          (s) => s.id === subscriptionId && s.userId === CURRENT_USER,
        )
      : undefined
    if (!item) throw new Error('商品不存在')
    if (
      subscriptionId
        ? !subscription ||
          subscription.productId !== productId ||
          !canRenew(subscription)
        : !item.listed || !item.purchaseEnabled
    )
      throw new Error('该商品暂不可购买或续费')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('请填写有效的通知邮箱')
    if (item.targetField !== 'NONE' && !target.trim())
      throw new Error('请填写服务所需信息')
    if (
      item.targetField === 'EMAIL' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)
    )
      throw new Error('请填写有效的目标邮箱')
    if (email.length > 254 || target.length > 160)
      throw new Error('填写内容过长')
    const at = timestamp()
    const next: Order = {
      id: 'MOCK-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
      userId: CURRENT_USER,
      productId,
      productName: item.name,
      productType: item.type,
      term: item.term,
      amountFen: subscriptionId ? item.renewalPriceFen! : item.priceFen,
      contactEmail: email,
      target: target.trim(),
      subscriptionId,
      kind: subscriptionId
        ? 'RENEWAL'
        : item.type === 'ONE_TIME'
          ? 'ONE_TIME'
          : 'INITIAL',
      createdAt: at,
      paid: false,
      status: 'PENDING',
      fulfillment: 'NOT_STARTED',
      refund: 'NONE',
      timeline: [{ label: '创建本地模拟订单 · 未进行付款', at }],
    }
    state.orders.unshift(next)
    if (subscription) subscription.orderIds.push(next.id)
    return next
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
      item.refundedAt = timestamp()
    }
    item.timeline.push({
      label: success
        ? '模拟退款成功 · 无真实资金变动'
        : '模拟退款失败 · 可重试',
      at: timestamp(),
    })
  }
  return {
    state,
    customer,
    product,
    canRenew,
    saveProduct,
    checkout,
    complete,
    requestRefund,
    resolveRefund,
  }
}
export const mock = createMockStore()
