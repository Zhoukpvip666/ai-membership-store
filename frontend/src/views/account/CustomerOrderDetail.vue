<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { ApiError } from '../../api/client'
import { OrderRequest } from '../../api/orders'
import {
  customerOrderPath,
  readCustomerOrder,
  type CustomerOrder,
  type OrderGuidance,
} from '../../api/customer-orders'
import type { FormData } from '../../api/subscriptions'
import OrderNumber from '../../components/OrderNumber.vue'
import ProductFormInputs from '../../components/ProductFormInputs.vue'
import CustomerWechatPayment from './CustomerWechatPayment.vue'
import { parseFormData } from '../../../../backend/src/contracts/form-data'
import { hasCredentialText } from '../../../../backend/src/contracts/credential-fields'
import { formValueLabel, money } from '../../stores/format'
import {
  businessDate,
  fulfillmentLabels,
  kindLabels,
} from '../admin/orders/state'
import {
  canCancel,
  customerPaymentLabels,
  orderStatus,
  paymentTimeLeft,
  safeFrozenForm,
  timeline,
  useNarrowOrderDialog,
  useOrderClock,
} from './customer-order-state'

const props = defineProps<{ id: string; guidance?: OrderGuidance }>()
const emit = defineEmits<{
  close: [id: string]
  changed: []
  retryGuidance: []
}>()
const order = shallowRef<CustomerOrder>()
const mode = ref<'detail' | 'edit' | 'cancel' | 'claim'>('detail')
const loading = ref(false)
const busy = ref(false)
const uncertain = ref(false)
const error = ref('')
const actionError = ref('')
const notice = ref('')
const draft = ref<FormData>({})
const reason = ref('')
const receivedAt = ref(0)
const clock = useOrderClock()
const mobile = useNarrowOrderDialog()
const request = new OrderRequest<CustomerOrder>()
const snapshot = computed(() =>
  order.value ? safeFrozenForm(order.value) : null,
)
const remaining = computed(() =>
  order.value ? paymentTimeLeft(order.value, receivedAt.value, clock.value) : 0,
)
const date = (value: string) =>
  props.guidance ? businessDate(value, props.guidance.businessTimezone) : '—'

async function load() {
  loading.value = true
  error.value = ''
  order.value = undefined
  try {
    const result = await readCustomerOrder(props.id)
    receivedAt.value = performance.now()
    order.value = result.order
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.status === 404
        ? '订单不存在。'
        : '无法读取订单详情，请重试。'
  } finally {
    loading.value = false
  }
}

function begin(action: 'edit' | 'cancel' | 'claim') {
  mode.value = action
  actionError.value = ''
  notice.value = ''
  reason.value = ''
  request.reset()
  if (action === 'edit' && snapshot.value)
    draft.value = structuredClone(snapshot.value.data)
}

async function save() {
  const current = order.value
  if (busy.value || !current) return
  actionError.value = ''
  busy.value = true
  try {
    if (uncertain.value) await request.retry()
    else if (mode.value === 'edit' && snapshot.value) {
      let formData: FormData
      try {
        formData = parseFormData(snapshot.value.schema, draft.value)
      } catch {
        throw new Error('请核对服务信息并填写所有必填项。')
      }
      if (
        Object.values(formData)
          .flat()
          .some((v) => typeof v === 'string' && hasCredentialText(v))
      )
        throw new Error('请勿在订单中填写密码、验证码或认证凭证。')
      await request.send(customerOrderPath(current.id), 'PATCH', {
        expectedVersion: current.version,
        formData,
      })
    } else if (mode.value === 'cancel') {
      const text = reason.value.trim()
      if (text.length > 500) throw new Error('取消原因最多 500 字。')
      await request.send(customerOrderPath(current.id) + '/cancel', 'POST', {
        expectedVersion: current.version,
        ...(text ? { reason: text } : {}),
      })
    } else if (mode.value === 'claim') {
      await request.send(
        customerOrderPath(current.id) + '/payment-claim',
        'POST',
        {
          expectedVersion: current.version,
        },
      )
    } else return
    if (mode.value !== 'claim')
      notice.value =
        mode.value === 'cancel' ? '订单已取消。' : '服务信息已更新。'
    await refresh()
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      [
        'VERSION_CONFLICT',
        'ORDER_NOT_EDITABLE',
        'ORDER_NOT_CANCELLABLE',
        'ORDER_NOT_PAYABLE',
      ].includes(cause.code)
    ) {
      notice.value = '订单状态或版本已变化，请核对最新详情后再操作。'
      await refresh()
    } else {
      uncertain.value =
        cause instanceof SyntaxError ||
        (cause instanceof ApiError &&
          (cause.status === 0 || cause.status >= 500))
      actionError.value =
        cause instanceof Error ? cause.message : '操作失败，请重试。'
    }
  } finally {
    busy.value = false
  }
}
async function refresh() {
  uncertain.value = false
  request.reset()
  mode.value = 'detail'
  emit('changed')
  await load()
}

onMounted(load)
</script>
<template>
  <ElDialog
    :model-value="true"
    :title="
      mode === 'edit'
        ? '修改订单'
        : mode === 'cancel'
          ? '确认取消订单'
          : mode === 'claim'
            ? '确认付款核实'
            : '订单详情'
    "
    :width="mobile ? '100%' : 'min(720px, 92vw)'"
    :fullscreen="mobile"
    :show-close="!busy && !uncertain"
    :close-on-press-escape="!busy && !uncertain"
    :close-on-click-modal="false"
    @close="emit('close', id)"
  >
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取订单…</p>
    <p v-else-if="error" role="alert" class="form-error">
      {{ error }} <ElButton link @click="load">重试详情</ElButton>
    </p>
    <div v-else-if="order" class="customer-order-detail">
      <h2>{{ order.productNameSnapshot }}</h2>
      <p v-if="mode !== 'detail' || remaining === 0" class="muted">
        <OrderNumber :order-no="order.orderNo" />
      </p>
      <template v-if="mode === 'detail'">
        <div class="customer-order-summary">
          <strong>{{ orderStatus(order) }}</strong>
          <span>付款 · {{ customerPaymentLabels[order.paymentStatus] }}</span>
          <span>履约 · {{ fulfillmentLabels[order.fulfillmentStatus] }}</span>
        </div>
        <p v-if="orderStatus(order) === '状态待确认'" class="muted">
          请联系商家确认订单状态。
        </p>
        <p v-if="order.productDescriptionSnapshot" class="plain">
          {{ order.productDescriptionSnapshot }}
        </p>
        <dl class="customer-facts">
          <div>
            <dt>类型</dt>
            <dd>
              {{
                order.productTypeSnapshot === 'SUBSCRIPTION'
                  ? '订阅商品'
                  : '一次性商品'
              }}
              · {{ kindLabels[order.kind] }}
            </dd>
          </div>
          <div>
            <dt>应付金额</dt>
            <dd>{{ money(order.amountFen) }}</dd>
          </div>
          <div>
            <dt>商品原价</dt>
            <dd>
              {{
                order.priceSnapshotFen === null
                  ? '暂无历史原价'
                  : money(order.priceSnapshotFen)
              }}
            </dd>
          </div>
          <div>
            <dt>服务周期</dt>
            <dd>
              {{ order.termSnapshot
              }}<span
                v-if="
                  order.servicePeriodUnitSnapshot &&
                  order.servicePeriodCountSnapshot
                "
              >
                · {{ order.servicePeriodCountSnapshot }}
                {{
                  { DAY: '天', MONTH: '月', YEAR: '年' }[
                    order.servicePeriodUnitSnapshot
                  ]
                }}</span
              >
            </dd>
          </div>
          <div>
            <dt>联系人邮箱</dt>
            <dd>{{ order.contactEmailSnapshot }}</dd>
          </div>
          <div>
            <dt>原始付款截止</dt>
            <dd>
              <time :datetime="order.expiresAt">{{
                date(order.expiresAt)
              }}</time>
            </dd>
          </div>
        </dl>
        <CustomerWechatPayment
          v-if="remaining > 0"
          :order="order"
          :remaining="remaining"
          @claim="begin('claim')"
        />
        <section
          v-if="guidance?.paymentInstructions.trim()"
          aria-label="商家备注"
        >
          <h3>商家备注</h3>
          <p class="plain">{{ guidance.paymentInstructions }}</p>
        </section>
        <p v-else-if="!guidance" class="muted">
          商家备注暂不可用。<ElButton link @click="emit('retryGuidance')"
            >重试读取</ElButton
          >
        </p>
        <p v-if="orderStatus(order) === '付款待核实'" class="inline-note">
          已提交付款核实，请勿重复转账。管理员确认实际到账后才会处理订单。
          订单创建满 24 小时未核实可能自动取消。如已转账，请联系商家线下处理。
        </p>
        <p
          v-if="order.fulfillmentStatus === 'CANCELLED' && order.amountFen > 0"
          class="muted"
        >
          如已付款，请联系商家线下处理款项。
        </p>
        <section
          v-if="snapshot?.schema.fields.length"
          aria-labelledby="customer-service-label"
        >
          <h3 id="customer-service-label">服务信息</h3>
          <dl class="customer-facts">
            <div v-for="field in snapshot.schema.fields" :key="field.id">
              <dt>{{ field.label }}</dt>
              <dd class="plain">
                {{ formValueLabel(field, snapshot.data[field.id]) }}
              </dd>
            </div>
          </dl>
        </section>
        <p v-else-if="!snapshot" class="muted">此订单没有可显示的服务信息。</p>
        <section aria-label="订单进度">
          <h3>订单进度</h3>
          <ol class="customer-timeline">
            <li v-for="item in timeline(order)" :key="item.label">
              <strong>{{ item.label }}</strong><time :datetime="item.at">{{
                date(item.at)
              }}</time>
            </li>
          </ol>
        </section>
      </template>
      <template v-else>
        <p v-if="actionError" role="alert" class="form-error">
          {{ actionError }}
        </p>
        <p v-if="uncertain" role="status">结果尚未确认，可重试原请求。</p>
        <p v-if="mode === 'claim'">
          请确认你已在微信完成付款，且付款金额和填写的商城订单号均正确。
        </p>
        <ElForm
          v-if="mode === 'edit' && snapshot"
          label-position="top"
          :disabled="busy || uncertain"
          @submit.prevent="save"
        >
          <p>修改此订单的服务信息。请勿填写密码、验证码或认证凭证。</p>
          <ProductFormInputs
            v-model="draft"
            :schema="snapshot.schema"
            :disabled="busy || uncertain"
          />
        </ElForm>
        <ElForm
          v-else-if="mode === 'cancel'"
          label-position="top"
          :disabled="busy || uncertain"
          @submit.prevent="save"
        >
          <p>取消后无法恢复此订单。</p>
          <p
            v-if="order.paymentStatus === 'PENDING_VERIFICATION'"
            class="inline-note"
            role="note"
          >
            取消会关闭待核实付款记录。如果已转账但尚未核实，请联系商家，在订单系统外处理款项。
          </p>
          <ElFormItem label="取消原因（可选）">
            <ElInput
              v-model="reason"
              type="textarea"
              maxlength="500"
              aria-label="取消原因（可选）"
            />
          </ElFormItem>
        </ElForm>
      </template>
    </div>
    <template #footer>
      <div class="customer-order-actions">
        <template v-if="mode === 'detail'">
          <ElButton
            v-if="order && remaining > 0 && snapshot?.schema.fields.length"
            :disabled="busy"
            type="primary"
            @click="begin('edit')"
            >修改订单</ElButton
          >
          <ElButton
            v-if="order && canCancel(order)"
            :disabled="busy"
            @click="begin('cancel')"
            >取消订单</ElButton
          >
        </template>
        <template v-else>
          <ElButton :disabled="busy || uncertain" @click="mode = 'detail'"
            >返回详情</ElButton
          >
          <ElButton
            :loading="busy"
            :type="mode === 'cancel' ? 'danger' : 'primary'"
            @click="save"
          >
            {{
              uncertain
                ? '重试原请求'
                : mode === 'cancel'
                  ? '确认取消'
                  : mode === 'claim'
                    ? '提交付款核实'
                    : '保存修改'
            }}
          </ElButton>
        </template>
      </div>
    </template>
  </ElDialog>
</template>
<style scoped>
.customer-order-detail {
  min-width: 0;
  overflow-wrap: anywhere;
}
.customer-order-summary,
.customer-order-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  align-items: center;
}
.customer-order-summary {
  padding-block: 0.75rem;
}
.customer-order-summary strong {
  color: #284f9a;
}
.customer-order-actions {
  justify-content: flex-end;
}
.customer-order-actions .el-button {
  margin: 0;
}
.customer-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.customer-facts dt {
  color: #60708a;
}
.customer-facts dd {
  margin: 0.25rem 0 0;
}
.plain {
  white-space: pre-wrap;
}
.customer-timeline {
  padding-inline-start: 1.25rem;
}
.customer-timeline li {
  margin-top: 0.5rem;
}
.customer-timeline time {
  margin-inline-start: 0.55rem;
}
@media (max-width: 640px) {
  .customer-facts {
    grid-template-columns: minmax(0, 1fr);
  }
  .customer-order-actions .el-button {
    width: 100%;
  }
}
</style>
