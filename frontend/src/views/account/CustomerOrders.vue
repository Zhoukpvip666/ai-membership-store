<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import {
  readCustomerOrders,
  readOrderGuidance,
  type CustomerOrder,
  type OrderGuidance,
} from '../../api/customer-orders'
import { money } from '../../stores/format'
import {
  businessDate,
  kindLabels,
  fulfillmentLabels,
} from '../admin/orders/state'
import {
  countdown,
  customerPaymentLabels,
  orderPresets,
  orderStatus,
  paymentTimeLeft,
  useOrderClock,
} from './customer-order-state'
import CustomerOrderDetail from './CustomerOrderDetail.vue'

const rows = shallowRef<CustomerOrder[]>([])
const guidance = shallowRef<OrderGuidance>()
const guidanceError = ref('')
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const selected = ref('')
const search = ref('')
const kind = ref('')
const preset = ref(0)
const filters = shallowRef(new URLSearchParams())
const receivedAt = ref(0)
const clock = useOrderClock()
let sequence = 0

async function loadGuidance() {
  guidanceError.value = ''
  guidance.value = undefined
  try {
    guidance.value = await readOrderGuidance()
  } catch {
    guidanceError.value = '暂时无法读取付款说明和业务时区。'
  }
}

async function loadOrders() {
  const current = ++sequence
  const query = new URLSearchParams(filters.value)
  query.set('page', String(page.value))
  query.set('pageSize', '20')
  loading.value = true
  error.value = ''
  try {
    const result = await readCustomerOrders(query)
    if (current !== sequence) return
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
    if (page.value > lastPage) {
      page.value = lastPage
      return await loadOrders()
    }
    receivedAt.value = performance.now()
    rows.value = result.items
    total.value = result.total
  } catch {
    if (current !== sequence) return
    rows.value = []
    total.value = 0
    error.value = '无法读取订单，请重试。'
  } finally {
    if (current === sequence) loading.value = false
  }
}

function applyFilters() {
  const query = new URLSearchParams()
  if (search.value.trim()) query.set('search', search.value.trim())
  if (kind.value) query.set('kind', kind.value)
  for (const [key, value] of Object.entries(orderPresets[preset.value]!.query))
    query.set(key, value)
  filters.value = query
  page.value = 1
  void loadOrders()
}

function selectPreset(index: number) {
  preset.value = index
  applyFilters()
}

const date = (value: string) =>
  guidance.value ? businessDate(value, guidance.value.businessTimezone) : '—'
const left = (order: CustomerOrder) =>
  paymentTimeLeft(order, receivedAt.value, clock.value)
onMounted(() => {
  void loadOrders()
  void loadGuidance()
})
</script>

<template>
  <section class="customer-orders">
    <div class="page-heading">
      <div>
        <h1>我的订单</h1>
        <p v-if="guidance" class="muted">
          {{ guidance.storeName }} · {{ guidance.businessTimezone }}
        </p>
      </div>
    </div>
    <p v-if="guidanceError" role="alert" class="form-error">
      {{ guidanceError }}
      <ElButton link @click="loadGuidance">重试付款说明</ElButton>
    </p>
    <div class="panel order-list-panel">
      <div class="filter-row" role="group" aria-label="订单状态">
        <button
          v-for="(item, index) in orderPresets"
          :key="item.label"
          type="button"
          :class="['filter-button', { selected: preset === index }]"
          :aria-pressed="preset === index"
          @click="selectPreset(index)"
        >
          {{ item.label }}
        </button>
      </div>
      <form class="customer-order-filters" @submit.prevent="applyFilters">
        <ElInput
          v-model="search"
          aria-label="搜索订单"
          maxlength="254"
          clearable
          placeholder="订单号或商品名称"
        />
        <select v-model="kind" aria-label="订单类型">
          <option value="">全部类型</option>
          <option
            v-for="(name, value) in kindLabels"
            :key="value"
            :value="value"
          >
            {{ name }}
          </option>
        </select>
        <ElButton native-type="submit" type="primary">查询订单</ElButton>
      </form>

      <p v-if="loading" role="status">正在读取订单…</p>
      <p v-else-if="error" class="form-error" role="alert">
        {{ error }} <ElButton link @click="loadOrders">重试订单</ElButton>
      </p>
      <p v-else-if="!rows.length" class="muted">暂无符合条件的订单</p>
      <template v-else>
        <ul class="customer-order-list" aria-label="订单列表">
          <li v-for="order in rows" :key="order.id" class="customer-order-card">
            <div>
              <h2>{{ order.productNameSnapshot }}</h2>
              <p class="muted">
                {{ order.orderNo }} · {{ kindLabels[order.kind] }}
              </p>
            </div>
            <time :datetime="order.createdAt">{{ date(order.createdAt) }}</time>
            <strong>{{ money(order.amountFen) }}</strong>
            <div>
              <strong class="customer-order-status">{{
                orderStatus(order)
              }}</strong>
              <p class="muted">
                付款 · {{ customerPaymentLabels[order.paymentStatus] }}
              </p>
              <p class="muted">
                履约 · {{ fulfillmentLabels[order.fulfillmentStatus] }}
              </p>
              <p v-if="left(order) > 0" class="customer-countdown">
                剩余 {{ countdown(left(order)) }}
              </p>
            </div>
            <ElButton @click="selected = order.id">查看详情</ElButton>
          </li>
        </ul>
        <div class="customer-order-pages">
          <span>共 {{ total }} 笔订单</span>
          <ElPagination
            v-model:current-page="page"
            :page-size="20"
            :total="total"
            layout="prev, pager, next"
            :pager-count="5"
            @current-change="loadOrders"
          />
        </div>
      </template>
    </div>
    <CustomerOrderDetail
      v-if="selected"
      :key="selected"
      :id="selected"
      :guidance="guidance"
      @close="selected = ''"
      @changed="loadOrders"
      @retry-guidance="loadGuidance"
    />
  </section>
</template>

<style scoped>
.order-list-panel {
  padding: 1rem;
}
.customer-order-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(8rem, auto) auto;
  gap: 0.75rem;
  margin: 1rem 0;
}
.customer-order-filters select {
  min-width: 0;
  border: 1px solid #dbe2ef;
  border-radius: 8px;
  background: white;
  color: inherit;
  padding: 0.35rem 0.6rem;
  font: inherit;
}
.customer-order-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.customer-order-card {
  display: grid;
  grid-template-columns:
    minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 0.7fr)
    minmax(0, 1.15fr) auto;
  align-items: center;
  gap: 0.75rem;
  border-top: 1px solid #e7ecf4;
  padding: 1rem 0.1rem;
  overflow-wrap: anywhere;
}
.customer-order-card h2 {
  font-size: 1rem;
}
.customer-order-card p {
  margin: 0.25rem 0 0;
}
.customer-countdown {
  font-variant-numeric: tabular-nums;
}
.customer-order-status {
  color: #284f9a;
}
.customer-order-pages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
@media (max-width: 640px) {
  .customer-order-filters,
  .customer-order-card {
    grid-template-columns: minmax(0, 1fr);
  }
  .customer-order-filters select {
    min-height: 32px;
  }
  .customer-order-card {
    border: 1px solid #e7ecf4;
    border-radius: 12px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .customer-order-card .el-button {
    width: 100%;
  }
}
</style>
