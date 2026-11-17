export type ProductType = 'SUBSCRIPTION' | 'ONE_TIME'
export type OrderStatus = 'PENDING' | 'COMPLETED' | 'REFUNDED'
export type RefundStatus = 'NONE' | 'PROCESSING' | 'SUCCESS' | 'FAILED'
export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'TERMINATED'

// View-only mock records, not a database schema or backend API contract.
export interface Product {
  id: string
  name: string
  type: ProductType
  priceFen: number
  renewalPriceFen: number | null
  term: string
  listed: boolean
  purchaseEnabled: boolean
  renewalEnabled: boolean
  targetField: 'EMAIL' | 'TEXT' | 'NONE'
}
export interface Order {
  id: string
  userId: string
  productId: string
  productName: string
  productType: ProductType
  term: string
  amountFen: number
  contactEmail: string
  target: string
  kind: 'INITIAL' | 'RENEWAL' | 'ONE_TIME'
  subscriptionId?: string
  createdAt: string
  verifiedAt?: string
  paid: boolean
  status: OrderStatus
  fulfillment: 'NOT_STARTED' | 'PROCESSING' | 'COMPLETED'
  refund: RefundStatus
  refundedAt?: string
  timeline: { label: string; at: string }[]
}
export interface Subscription {
  id: string
  userId: string
  productId: string
  productName: string
  target: string
  startedAt: string
  expiresAt: string
  renewalPriceFen: number
  status: SubscriptionStatus
  orderIds: string[]
}
export interface Customer {
  id: string
  name: string
  email: string
  createdAt: string
  active: boolean
}
