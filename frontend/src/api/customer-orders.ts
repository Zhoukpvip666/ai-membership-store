import { api } from './client'
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

export const customerOrderPath = (id: string) =>
  '/customer/orders/' + encodeURIComponent(id)
export const readCustomerOrders = (query: URLSearchParams) =>
  api<PageResult<CustomerOrder>>('/customer/orders?' + query)
export const readCustomerOrder = (id: string) =>
  api<{ order: CustomerOrder }>(customerOrderPath(id))
export const readOrderGuidance = () =>
  api<OrderGuidance>('/customer/order-guidance')
