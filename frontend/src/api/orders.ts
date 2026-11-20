import { api, ApiError } from './client'
import type { ProductFormSchema } from './products'
import type { FormData, PageResult } from './subscriptions'
export type PaymentStatus =
  | 'UNPAID'
  | 'PENDING_VERIFICATION'
  | 'PAID'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'NOT_REQUIRED'
export type FulfillmentStatus =
  'NOT_STARTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export interface AdminOrder {
  id: string
  orderNo: string
  version: number
  productId: string
  kind: 'INITIAL' | 'ONE_TIME' | 'RENEWAL'
  productNameSnapshot: string
  productDescriptionSnapshot: string | null
  productTypeSnapshot: 'SUBSCRIPTION' | 'ONE_TIME'
  priceSnapshotFen: number | null
  termSnapshot: string
  servicePeriodUnitSnapshot: 'DAY' | 'MONTH' | 'YEAR' | null
  servicePeriodCountSnapshot: number | null
  renewalPriceSnapshotFen: number | null
  formSchemaSnapshot: ProductFormSchema | null
  formData: FormData | null
  amountFen: number
  contactEmailSnapshot: string
  targetIdentifier: string | null
  paymentStatus: PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  createdAt: string
  paidAt: string | null
  paymentConfirmedAt: string | null
  fulfilledAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  expiresAt: string
  remainingSeconds: number
  internalNote: string | null
  customer: {
    id: string
    username: string | null
    loginEmail: string
    notificationEmail: string | null
  }
  creator: {
    source: 'USER' | 'ADMIN' | 'SYSTEM_RENEWAL' | null
    adminId: string | null
    userId: string | null
  }
}
export interface LinkedSubscription {
  id: string
  sourceType: 'ADMIN' | 'SYSTEM' | 'ORDER'
  status: 'ACTIVE' | 'TERMINATED'
  version: number
  productNameSnapshot: string
  startedAt: string
  expiresAt: string
}
export interface OrderDetail extends AdminOrder {
  linkedSubscription: LinkedSubscription | null
}
export interface Evidence {
  id: string
  orderId: string
  kind: 'PAYMENT' | 'REFUND'
  amountFen: number
  channel: 'WECHAT' | 'ALIPAY' | 'BANK_TRANSFER' | 'CASH' | 'OTHER'
  status: 'PENDING' | 'CONFIRMED' | 'FAILED'
  occurredAt: string
  confirmedAt: string | null
  externalReference: string | null
  note: string | null
  createdAt: string
  updatedAt: string
  createdByAdminId: string
  confirmedByAdminId: string | null
}
export interface OrderEvent {
  id: string
  eventType: string
  operation: string | null
  actorType: 'ADMIN' | 'USER' | 'SYSTEM'
  actorDisplayName: string
  createdAt: string
  note: string | null
  summary: Record<string, string | number | null>
}
export const readOrders = (query: URLSearchParams) =>
  api<PageResult<AdminOrder>>('/admin/orders?' + query)
export const readOrder = (id: string) =>
  api<{ order: OrderDetail }>('/admin/orders/' + encodeURIComponent(id))
export const readEvents = (id: string, page: number) =>
  api<PageResult<OrderEvent>>(
    `/admin/orders/${encodeURIComponent(id)}/events?page=${page}&pageSize=20`,
  )
export const readEvidence = (
  id: string,
  kind: 'payments' | 'refunds',
  page: number,
  pageSize = 20,
) =>
  api<PageResult<Evidence>>(
    `/admin/orders/${encodeURIComponent(id)}/${kind === 'payments' ? 'payment-transactions' : 'refunds'}?page=${page}&pageSize=${pageSize}`,
  )

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
// Memory only. Serialize once, then reuse the exact body/key after an unknown
// response. A changed intent has a different fingerprint and receives a new key.
export class OrderRequest {
  private context?: { fingerprint: string; body: unknown; key: string }
  reset() {
    this.context = undefined
  }
  async send(path: string, method: string, input: unknown) {
    const fingerprint = canonical({ path, method, input })
    if (this.context?.fingerprint !== fingerprint)
      this.context = {
        fingerprint,
        body: JSON.parse(canonical(input)),
        key: crypto.randomUUID(),
      }
    const result = await api<{ order: AdminOrder }>(
      path,
      method,
      this.context.body,
      this.context.key,
    )
    // A successful HTTP status with an unusable JSON envelope is still an
    // unknown outcome. Keep the original context instead of risking a new key.
    const order = result?.order
    if (
      !order ||
      typeof order.id !== 'string' ||
      !order.id ||
      typeof order.orderNo !== 'string' ||
      !Number.isInteger(order.version) ||
      order.version < 1 ||
      !Number.isInteger(order.amountFen) ||
      order.amountFen < 0 ||
      ![
        'UNPAID',
        'PENDING_VERIFICATION',
        'PAID',
        'REFUND_PENDING',
        'REFUNDED',
        'NOT_REQUIRED',
      ].includes(order.paymentStatus) ||
      ![
        'NOT_STARTED',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
      ].includes(order.fulfillmentStatus)
    )
      throw new ApiError(
        0,
        'INVALID_RESPONSE',
        '无法确认服务器响应，请重试原请求',
      )
    this.reset()
    return result
  }
}
