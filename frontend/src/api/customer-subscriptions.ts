import { api } from './client'
import type { PageResult } from './subscriptions'

export interface CustomerSubscription {
  id: string
  productNameSnapshot: string
  termSnapshot: string
  status: 'ACTIVE' | 'EXPIRED' | 'TERMINATED'
  startedAt: string
  expiresAt: string
  renewalPriceFen: number
  sourceOrder: { id: string; orderNo: string } | null
}

export const readCustomerSubscriptions = (query: URLSearchParams) =>
  api<PageResult<CustomerSubscription> & { businessTimezone: string }>(
    '/customer/subscriptions?' + query,
  )
export const readCustomerSubscription = (id: string) =>
  api<{ subscription: CustomerSubscription; businessTimezone: string }>(
    '/customer/subscriptions/' + encodeURIComponent(id),
  )
