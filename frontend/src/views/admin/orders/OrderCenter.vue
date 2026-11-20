<script setup lang="ts">
import { ElTag } from 'element-plus'
import { onMounted, ref } from 'vue'
import { readOrders, type AdminOrder } from '../../../api/orders'
import { money, mask } from '../../../stores/format'
import { settings } from '../../../stores/settings'
import {
  paymentLabels,
  fulfillmentLabels,
  kindLabels,
  businessDate,
} from './state'
import OrderDetail from './OrderDetail.vue'
import OrderForm from './OrderForm.vue'
const rows = ref<AdminOrder[]>([]),
  total = ref(0),
  page = ref(1),
  pageSize = ref(20)
const loading = ref(false),
  error = ref(''),
  selected = ref(''),
  creating = ref(false)
const search = ref(''),
  productType = ref(''),
  kind = ref(''),
  paymentStatus = ref(''),
  fulfillmentStatus = ref(''),
  sort = ref('desc'),
  tab = ref('ALL')
const tabs = [
  { value: 'ALL', label: '全部' },
  { value: 'UNPAID', label: '待付款' },
  { value: 'PENDING_VERIFICATION', label: '待核实付款' },
  { value: 'PROCESSING', label: '待履约' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: 'REFUNDED', label: '已退款' },
]
let sequence = 0
async function load(reset = false) {
  if (reset) page.value = 1
  const current = ++sequence
  loading.value = true
  error.value = ''
  const query = new URLSearchParams({
    page: String(page.value),
    pageSize: String(pageSize.value),
    search: search.value.trim(),
    sort: sort.value,
  })
  for (const [key, value] of Object.entries({
    productType: productType.value,
    kind: kind.value,
    paymentStatus: paymentStatus.value,
    fulfillmentStatus: fulfillmentStatus.value,
  }))
    if (value) query.set(key, value)
  try {
    const result = await readOrders(query)
    if (current !== sequence) return
    rows.value = result.items
    total.value = result.total
  } catch (e) {
    if (current === sequence) {
      rows.value = []
      total.value = 0
      error.value = e instanceof Error ? e.message : '订单读取失败'
    }
  } finally {
    if (current === sequence) loading.value = false
  }
}
function chooseTab(value: string) {
  tab.value = value
  paymentStatus.value = ''
  fulfillmentStatus.value = ''
  if (['UNPAID', 'PENDING_VERIFICATION', 'REFUNDED'].includes(value))
    paymentStatus.value = value
  if (['PROCESSING', 'COMPLETED', 'CANCELLED'].includes(value))
    fulfillmentStatus.value = value
  void load(true)
}
function saved(order: AdminOrder) {
  creating.value = false
  selected.value = order.id
  void load(true)
}
onMounted(() => {
  void load()
})
</script>
<template>
  <section class="order-center">
    <div class="page-heading">
      <div>
        <span class="eyebrow">ORDERS</span>
        <h1>订单管理</h1>
        <p class="muted">本地订单与人工操作记录 · 不进行资金转移</p>
      </div>
      <ElButton type="primary" @click="creating = true">新建订单</ElButton>
    </div>
    <div class="panel">
      <div class="filter-row order-tabs" role="group" aria-label="订单状态">
        <button
          v-for="item in tabs"
          :key="item.value"
          :class="['filter-button', { selected: tab === item.value }]"
          :aria-pressed="tab === item.value"
          @click="chooseTab(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
      <form class="order-filters" @submit.prevent="load(true)">
        <ElInput
          v-model="search"
          aria-label="搜索订单"
          placeholder="订单号、客户邮箱／用户名／标签、商品名称"
          clearable
        />
        <ElSelect
          v-model="productType"
          aria-label="商品类型筛选"
          placeholder="全部商品类型"
          clearable
          ><ElOption label="订阅商品" value="SUBSCRIPTION" /><ElOption
            label="一次性商品"
            value="ONE_TIME"
        /></ElSelect>
        <ElSelect
          v-model="kind"
          aria-label="订单类型筛选"
          placeholder="全部订单类型"
          clearable
          ><ElOption
            v-for="(label, value) in kindLabels"
            :key="value"
            :label="label"
            :value="value"
        /></ElSelect>
        <ElSelect
          v-model="paymentStatus"
          aria-label="付款状态筛选"
          placeholder="全部付款状态"
          clearable
          @change="tab = 'ALL'"
          ><ElOption
            v-for="(label, value) in paymentLabels"
            :key="value"
            :label="label"
            :value="value"
        /></ElSelect>
        <ElSelect
          v-model="fulfillmentStatus"
          aria-label="履约状态筛选"
          placeholder="全部履约状态"
          clearable
          @change="tab = 'ALL'"
          ><ElOption
            v-for="(label, value) in fulfillmentLabels"
            :key="value"
            :label="label"
            :value="value"
        /></ElSelect>
        <ElSelect v-model="sort" aria-label="创建时间排序"
          ><ElOption label="最新创建优先" value="desc" /><ElOption
            label="最早创建优先"
            value="asc"
        /></ElSelect>
        <ElButton native-type="submit" :loading="loading" type="primary"
          >查询订单</ElButton
        >
      </form>
      <p v-if="error" class="form-error" role="alert">
        {{ error }} <ElButton @click="load()">重试订单列表</ElButton>
      </p>
      <p v-if="loading" role="status">正在读取订单…</p>
      <p v-if="!loading && !error && !rows.length" role="status">
        暂无符合条件的订单
      </p>
      <div v-if="!error" class="order-table-scroll">
        <table class="order-table">
          <thead>
            <tr>
              <th>商品 / 订单</th>
              <th>客户</th>
              <th>创建时间</th>
              <th>金额</th>
              <th>付款状态</th>
              <th>履约状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>
                <strong>{{ row.productNameSnapshot }}</strong><small
                  >{{ row.orderNo }} · {{ kindLabels[row.kind] }}</small
                >
              </td>
              <td>
                {{
                  row.customer.username ||
                  row.customer.loginEmail.split('@')[0]
                }}<small>{{ mask(row.customer.loginEmail) }}</small>
              </td>
              <td>
                {{ businessDate(row.createdAt, settings.state.value.timezone) }}
              </td>
              <td>{{ money(row.amountFen) }}</td>
              <td>
                <ElTag>{{ paymentLabels[row.paymentStatus] }}</ElTag>
              </td>
              <td>
                <ElTag type="info">{{
                  fulfillmentLabels[row.fulfillmentStatus]
                }}</ElTag>
              </td>
              <td><ElButton @click="selected = row.id">查看详情</ElButton></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="order-pagination">
        <span aria-live="polite">共 {{ total }} 笔订单</span
        ><ElPagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="prev, pager, next"
          @current-change="load()"
        />
      </div>
    </div>
    <OrderDetail
      v-if="selected"
      :key="selected"
      :id="selected"
      @close="selected = ''"
      @changed="load()"
    />
    <OrderForm v-if="creating" @close="creating = false" @saved="saved" />
  </section>
</template>
<style>
.order-center {
  min-width: 0;
}
.order-filters {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(120px, 1fr));
  gap: 12px;
  margin: 20px 0;
}
.order-filters > * {
  min-width: 0;
}
.order-tabs {
  overflow-x: auto;
  max-width: 100%;
}
.order-tabs button {
  flex-shrink: 0;
}
.order-table-scroll {
  overflow-x: auto;
  max-width: 100%;
}
.order-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 850px;
  text-align: left;
}
.order-table th,
.order-table td {
  padding: 14px 12px;
  border-bottom: 1px solid var(--border, #e8ecf3);
  vertical-align: top;
}
.order-table th {
  color: #778196;
  font-size: 12px;
}
.order-table small {
  display: block;
  margin-top: 5px;
  color: #778196;
  overflow-wrap: anywhere;
}
.order-pagination,
.order-detail-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  flex-wrap: wrap;
}
.order-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 20px 0;
}
.order-dialog {
  max-width: calc(100vw - 24px);
}
.order-dialog .panel {
  padding: 20px;
  margin-bottom: 18px;
  min-width: 0;
}
.order-dialog .el-dialog__body {
  overflow-wrap: anywhere;
}
.order-fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.order-fieldset .el-select {
  width: 100%;
}
.order-statuses,
.order-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
}
.order-actions .el-button + .el-button {
  margin-left: 0;
}
.order-facts {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(0, 3fr);
  gap: 10px;
}
.order-facts dt {
  color: #778196;
}
.order-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.order-plain {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.order-timeline {
  padding-left: 22px;
}
.order-timeline li {
  padding: 12px 0;
  border-bottom: 1px solid #e8ecf3;
}
@media (max-width: 760px) {
  .order-filters {
    grid-template-columns: minmax(0, 1fr);
  }
  .order-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .order-dialog {
    --el-dialog-margin-top: 0;
    width: 100% !important;
    max-width: 100%;
    margin: 0;
    min-height: 100dvh;
    border-radius: 0;
  }
  .order-pagination {
    align-items: flex-start;
    flex-direction: column;
  }
  .order-facts {
    grid-template-columns: minmax(80px, 1fr) minmax(0, 2fr);
  }
  .order-dialog .el-checkbox {
    white-space: normal;
    height: auto;
  }
  .order-dialog .el-checkbox__label {
    white-space: normal;
  }
}
</style>
