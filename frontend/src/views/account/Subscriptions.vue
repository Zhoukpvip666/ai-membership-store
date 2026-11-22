<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { CalendarDays } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { customerOrderLocation } from '../../api/customer-orders'
import {
  readCustomerSubscription,
  readCustomerSubscriptions,
  type CustomerSubscription,
} from '../../api/customer-subscriptions'
import { date, money } from '../../stores/format'
import { businessDate } from '../admin/orders/state'

const filters = ['ALL', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const
const labels = {
  ALL: '全部',
  ACTIVE: '有效',
  EXPIRED: '已到期',
  TERMINATED: '已终止',
}
const status = ref<(typeof filters)[number]>('ALL')
const rows = shallowRef<CustomerSubscription[]>([])
const page = ref(1)
const total = ref(0)
const pageSize = 20
const timezone = ref('Asia/Shanghai')
const loading = ref(true)
const error = ref('')
let listSequence = 0

async function load(targetPage = page.value) {
  const current = ++listSequence
  page.value = targetPage
  const query = new URLSearchParams({
    page: String(targetPage),
    pageSize: String(pageSize),
  })
  if (status.value !== 'ALL') query.set('status', status.value)
  loading.value = true
  error.value = ''
  try {
    const result = await readCustomerSubscriptions(query)
    if (current !== listSequence) return
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
    if (targetPage > lastPage) return await load(lastPage)
    rows.value = result.items
    total.value = result.total
    timezone.value = result.businessTimezone
  } catch {
    if (current !== listSequence) return
    rows.value = []
    total.value = 0
    error.value = '无法读取订阅，请重试。'
  } finally {
    if (current === listSequence) loading.value = false
  }
}

function filter(value: (typeof filters)[number]) {
  status.value = value
  void load(1)
}

const detailId = ref('')
const detail = shallowRef<CustomerSubscription>()
const detailTimezone = ref('')
const detailLoading = ref(false)
const detailError = ref('')
let detailSequence = 0

async function openDetail(id: string) {
  const current = ++detailSequence
  detailId.value = id
  detail.value = undefined
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await readCustomerSubscription(id)
    if (current !== detailSequence) return
    detail.value = result.subscription
    detailTimezone.value = result.businessTimezone
  } catch (cause) {
    if (current !== detailSequence) return
    detailError.value =
      cause instanceof ApiError && cause.status === 404
        ? '订阅不存在。'
        : '无法读取订阅详情，请重试。'
  } finally {
    if (current === detailSequence) detailLoading.value = false
  }
}

function closeDetail() {
  detailSequence++
  detailId.value = ''
  detail.value = undefined
}

onMounted(() => load())
onBeforeUnmount(() => {
  listSequence++
  detailSequence++
})
</script>

<template>
  <section>
    <div class="page-heading">
      <h1>我的订阅</h1>
      <span v-if="!loading && !error" class="muted">{{ total }} 项订阅</span>
    </div>
    <div class="filter-row" role="group" aria-label="订阅状态">
      <button
        v-for="value in filters"
        :key="value"
        :class="['filter-button', { selected: status === value }]"
        :aria-pressed="status === value"
        @click="filter(value)"
      >
        {{ labels[value] }}
      </button>
    </div>
    <div v-if="loading" class="panel empty-state" role="status">
      正在读取订阅…
    </div>
    <div v-else-if="error" class="panel empty-state" role="alert">
      <p>{{ error }}</p>
      <ElButton @click="load()">重试</ElButton>
    </div>
    <div v-else-if="!rows.length" class="panel empty-state">
      <CalendarDays :size="30" />
      <p>{{ status === 'ALL' ? '暂无订阅' : '暂无符合条件的订阅' }}</p>
    </div>
    <div v-else class="subscription-list">
      <article
        v-for="sub in rows"
        :key="sub.id"
        class="panel subscription-card"
      >
        <div class="subscription-top">
          <div class="subscription-icon"><CalendarDays :size="22" /></div>
          <div class="grow">
            <h2>{{ sub.productNameSnapshot }}</h2>
            <span class="muted">{{ sub.termSnapshot }}</span>
          </div>
          <span :class="['badge', sub.status === 'ACTIVE' ? 'green' : 'gray']">
            {{ labels[sub.status] }}
          </span>
        </div>
        <div class="subscription-bottom">
          <div>
            <span class="muted">到期日期</span>
            <strong>{{ date(sub.expiresAt, timezone) }}</strong>
          </div>
          <div>
            <span class="muted">续费价格</span>
            <strong>{{ money(sub.renewalPriceFen) }}</strong>
          </div>
          <div class="subscription-actions">
            <ElButton @click="openDetail(sub.id)">详情</ElButton>
          </div>
        </div>
      </article>
      <ElPagination
        v-if="total > pageSize"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        @current-change="load"
      />
    </div>
    <ElDialog
      :model-value="Boolean(detailId)"
      title="订阅详情"
      width="600px"
      class="responsive-dialog"
      @close="closeDetail"
    >
      <p v-if="detailLoading" role="status">正在读取订阅详情…</p>
      <div v-else-if="detailError" role="alert">
        <p>{{ detailError }}</p>
        <ElButton @click="openDetail(detailId)">重试详情</ElButton>
      </div>
      <template v-else-if="detail">
        <div class="detail-title">
          <div>
            <h3>{{ detail.productNameSnapshot }}</h3>
            <span class="muted">{{ detail.termSnapshot }}</span>
          </div>
          <span
            :class="['badge', detail.status === 'ACTIVE' ? 'green' : 'gray']"
          >
            {{ labels[detail.status] }}
          </span>
        </div>
        <dl class="detail-grid">
          <div>
            <dt>开始时间</dt>
            <dd>{{ businessDate(detail.startedAt, detailTimezone) }}</dd>
          </div>
          <div>
            <dt>到期时间</dt>
            <dd>{{ businessDate(detail.expiresAt, detailTimezone) }}</dd>
          </div>
          <div>
            <dt>续费价格</dt>
            <dd>{{ money(detail.renewalPriceFen) }}</dd>
          </div>
        </dl>
        <h4>关联订单</h4>
        <RouterLink
          v-if="detail.sourceOrder"
          :to="customerOrderLocation(detail.sourceOrder.id)"
        >
          {{ detail.sourceOrder.orderNo }}
        </RouterLink>
        <p v-else class="muted">暂无关联订单</p>
      </template>
    </ElDialog>
  </section>
</template>
