import { api, apiBlob } from './client'
import type { AdminOrder } from './orders'
import type { PageResult } from './subscriptions'

export type CustomerOrder = Pick<
  AdminOrder,
  | 'id'
  | 'version'
  | 'orderNo'
  | 'productId'
  | 'kind'
  | 'productNameSnapshot'
  | 'productDescriptionSnapshot'
  | 'productTypeSnapshot'
  | 'priceSnapshotFen'
  | 'termSnapshot'
  | 'servicePeriodUnitSnapshot'
  | 'servicePeriodCountSnapshot'
  | 'renewalPriceSnapshotFen'
  | 'formSchemaSnapshot'
  | 'formData'
  | 'amountFen'
  | 'contactEmailSnapshot'
  | 'targetIdentifier'
  | 'paymentStatus'
  | 'fulfillmentStatus'
  | 'createdAt'
  | 'paidAt'
  | 'paymentConfirmedAt'
  | 'fulfilledAt'
  | 'cancelledAt'
  | 'expiresAt'
  | 'remainingSeconds'
>

export interface OrderGuidance {
  storeName: string
  businessTimezone: string
  paymentInstructions: string
}

export function parseOrderId(value: unknown) {
  return typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined
}

export const customerOrderLocation = (orderId: string) => ({
  path: '/account/orders',
  query: { orderId },
})

export const customerOrderPath = (id: string) =>
  '/customer/orders/' + encodeURIComponent(id)
export const readCustomerOrders = (query: URLSearchParams) =>
  api<PageResult<CustomerOrder>>('/customer/orders?' + query)
export const readCustomerOrder = (id: string) =>
  api<{ order: CustomerOrder }>(customerOrderPath(id))
export const readCustomerWechatQr = (id: string, signal: AbortSignal) =>
  apiBlob(customerOrderPath(id) + '/wechat-qr', signal)
export const readOrderGuidance = () =>
  api<OrderGuidance>('/customer/order-guidance')
