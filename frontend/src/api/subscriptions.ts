import { api, type Customer } from './client'
import type { ProductFormSchema } from './products'
export type FormData = Record<string, string | number | string[]>
export interface Subscription {
  id: string
  userId: string
  productId: string
  sourceOrderId: string | null
  sourceType: 'ADMIN' | 'SYSTEM'
  status: 'ACTIVE' | 'TERMINATED'
  version: number
  startedAt: string
  expiresAt: string
  renewalPriceFen: number
  productNameSnapshot: string
  productDescriptionSnapshot: string | null
  productTypeSnapshot: 'SUBSCRIPTION' | 'ONE_TIME'
  priceSnapshotFen: number
  termSnapshot: string
  formSchemaSnapshot: ProductFormSchema
  formData: FormData
  note: string | null
  terminatedAt: string | null
  terminationReason: string | null
  createdAt: string
  user: Customer
  product: { id: string; archivedAt: string | null }
}
export interface SubscriptionEvent {
  id: string
  eventType: string
  actorType: 'ADMIN' | 'SYSTEM'
  actorAdmin: Customer | null
  reason: string | null
  createdAt: string
  beforeJson: Record<string, unknown> | null
  afterJson: Record<string, unknown> | null
}
export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
export const eventLabels: Record<string, string> = {
  CREATED: '创建',
  UPDATED: '修改',
  RENEWED: '直接续订',
  EXPIRY_ADJUSTED: '日期调整',
  PRICE_CHANGED: '续订价格调整',
  FORM_DATA_UPDATED: '服务信息调整',
  TERMINATED: '立即取消',
  AUTO_TERMINATED: '到期自动终止',
  ACTIVATED: '历史激活',
  MANUAL_GRANT: '历史手动授予',
  HISTORICAL_IMPORT: '历史导入',
  SUSPENDED: '历史暂停',
  RESUMED: '历史恢复',
  NOTE: '历史备注',
}
export const loadSubscription = async (id: string) =>
  (await api<{ subscription: Subscription }>('/admin/subscriptions/' + id))
    .subscription
