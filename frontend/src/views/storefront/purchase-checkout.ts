import { ref, shallowRef, watch, type Ref } from 'vue'
import {
  parseFormData,
  type FormData,
} from '../../../../backend/src/contracts/form-data'
import type { PurchaseProduct } from '../../api/catalog'
import { ApiError } from '../../api/client'
import { parseOrderId, type CustomerOrder } from '../../api/customer-orders'
import { OrderRequest } from '../../api/orders'
import { purchaseErrors } from './purchase-validation'

type Phase = 'edit' | 'review' | 'submitting' | 'uncertain' | 'complete'
const unavailableCodes = [
  'PRODUCT_NOT_FOUND',
  'PRODUCT_ARCHIVED',
  'PRODUCT_NOT_AVAILABLE',
  'PRODUCT_PERIOD_UNCONFIGURED',
  'PRODUCT_FORM_UNAVAILABLE',
]

export function usePurchaseCheckout(product: Ref<PurchaseProduct | undefined>) {
  const values = ref<FormData>({})
  const errors = ref<string[]>([])
  const message = ref('')
  const phase = ref<Phase>('edit')
  const review = shallowRef<FormData>()
  const confirmed = shallowRef<CustomerOrder>()
  const createRequest = () =>
    new OrderRequest<CustomerOrder>({
      timeoutMs: 30_000,
      validateOrder: (order) =>
        Boolean(parseOrderId(order.id)) &&
        Boolean(order.orderNo.trim()) &&
        typeof order.productNameSnapshot === 'string' &&
        typeof order.expiresAt === 'string' &&
        Number.isFinite(Date.parse(order.expiresAt)) &&
        Number.isInteger(order.remainingSeconds) &&
        order.remainingSeconds >= 0,
    })
  let request = createRequest()

  function edit() {
    if (phase.value !== 'review') return
    phase.value = 'edit'
    review.value = undefined
  }

  watch(
    values,
    () => {
      edit()
      if (phase.value !== 'edit') return
      errors.value = []
      message.value = ''
    },
    { deep: true, flush: 'sync' },
  )

  function reset() {
    request.reset()
    request = createRequest()
    phase.value = 'edit'
    values.value = {}
    review.value = undefined
    confirmed.value = undefined
    errors.value = []
    message.value = ''
  }

  function validate(current: PurchaseProduct) {
    message.value = ''
    errors.value = purchaseErrors(current.formSchema, values.value)
    if (errors.value.length) return
    return parseFormData(current.formSchema, values.value)
  }

  function check() {
    if (phase.value !== 'edit' || !product.value) return
    const data = validate(product.value)
    if (!data) return
    review.value = data
    phase.value = 'review'
  }

  async function submit() {
    const active = request
    const isRetry = phase.value === 'uncertain'
    const current = product.value
    if (!isRetry && (phase.value !== 'review' || !current)) return

    const formData = !isRetry && current ? validate(current) : undefined
    if (!isRetry && (!current || !formData)) {
      edit()
      return
    }
    phase.value = 'submitting'
    message.value = ''
    try {
      const result =
        current && formData
          ? await active.send('/customer/orders', 'POST', {
              productId: current.id,
              expectedProductUpdatedAt: current.updatedAt,
              formData,
            })
          : await active.retry()
      if (request !== active) return
      confirmed.value = result.order
      phase.value = 'complete'
      return 'created' as const
    } catch (cause) {
      if (request !== active) return
      if (
        !(cause instanceof ApiError) ||
        cause.status === 0 ||
        cause.status >= 500
      ) {
        phase.value = 'uncertain'
        return
      }
      if (
        cause.code === 'PRODUCT_CHANGED' ||
        unavailableCodes.includes(cause.code)
      ) {
        reset()
        return cause.code === 'PRODUCT_CHANGED'
          ? ('changed' as const)
          : ('unavailable' as const)
      }
      active.reset()
      phase.value = 'edit'
      review.value = undefined
      message.value =
        cause.code === 'IDEMPOTENCY_CONFLICT'
          ? '请求与已有订单不一致，请先到我的订单核实，再决定是否重新下单。'
          : cause.message
    }
  }

  return {
    values,
    errors,
    message,
    phase,
    review,
    confirmed,
    reset,
    check,
    edit,
    submit,
  }
}
