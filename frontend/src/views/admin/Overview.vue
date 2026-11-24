<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElAlert } from 'element-plus'
import {
  Banknote,
  WalletCards,
  ReceiptText,
  Clock3,
  ArrowRight,
} from '@lucide/vue'
import { mock } from '../../stores/mock'
import {
  date,
  money,
  orderLabels,
  orderDisplayStatus,
  paymentLabel,
  overview,
} from '../../stores/format'
import type { Order } from '../../types'
import OrderDialog from '../../components/OrderDialog.vue'
const stats = computed(() =>
  overview(mock.state.orders, mock.state.settings.timezone),
)
const selected = ref<Order>()
const metrics = computed(() => [
  {
    name: '今日已确认收款',
    value: money(stats.value.today),
    icon: Banknote,
    color: 'blue',
  },
  {
    name: '本月已确认收款',
    value: money(stats.value.month),
    icon: WalletCards,
    color: 'purple',
  },
  {
    name: '累计订单',
    value: String(stats.value.total),
    icon: ReceiptText,
    color: 'blue',
  },
  {
    name: '待发货订单',
    value: String(stats.value.pending),
    icon: Clock3,
    color: 'amber',
  },
])
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">OVERVIEW</span>
        <h1>经营概览</h1>
      </div>
      <span class="date-label"
        >{{ date(new Date().toISOString(), mock.state.settings.timezone) }} ·
        {{ mock.state.settings.timezone }}</span
      >
    </div>
    <ElAlert
      class="overview-demo"
      title="演示数据"
      description="本页的收款、订单、客户和订阅均为演示内容。请通过各管理页面查看真实业务记录。"
      type="warning"
      show-icon
      :closable="false"
    />
    <div class="metric-grid">
      <article
        v-for="metric in metrics"
        :key="metric.name"
        class="panel metric-card"
      >
        <div class="metric-top">
          <span>{{ metric.name }}</span><span
            :class="['metric-icon', metric.color]"
            ><component :is="metric.icon" :size="19"
          /></span>
        </div>
        <strong>{{ metric.value }}</strong><small>{{
          metric.name.includes('收款')
            ? '模拟已确认付款 − 模拟成功退款'
            : metric.name === '待发货订单'
              ? '仅统计已确认付款的待履约订单'
              : '全部本地演示记录'
        }}</small>
      </article>
    </div>
    <div class="panel">
      <div class="panel-heading">
        <h2>最近订单</h2>
        <RouterLink class="text-link" to="/admin/orders"
          >全部订单 <ArrowRight :size="15"
        /></RouterLink>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>商品 / 订单号</th>
              <th>客户</th>
              <th>金额</th>
              <th>付款状态</th>
              <th>订单状态</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in mock.state.orders.slice(0, 5)" :key="order.id">
              <td>
                <strong>{{ order.productName }}</strong><small class="mono">{{
                  order.id
                }}</small>
              </td>
              <td>{{ mock.customer(order.userId)?.name }}</td>
              <td class="strong">{{ money(order.amountFen) }}</td>
              <td>{{ paymentLabel(order) }}</td>
              <td>
                <span
                  :class="[
                    'badge',
                    order.status === 'COMPLETED'
                      ? 'green'
                      : !order.paid || order.status === 'REFUNDED'
                        ? 'gray'
                        : 'amber',
                  ]"
                  >{{ orderLabels[orderDisplayStatus(order)] }}</span
                >
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="selected = order"
                  >查看详情</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel subscription-summary">
      <div>
        <h2>订阅概况</h2>
        <span class="muted">当前演示订阅记录</span>
      </div>
      <div class="summary-count">
        <span class="online-dot"></span
        ><strong>{{
          mock.state.subscriptions.filter((s) => s.status === 'ACTIVE').length
        }}</strong
        ><span>有效订阅</span>
      </div>
      <div class="summary-count">
        <span class="offline-dot"></span
        ><strong>{{
          mock.state.subscriptions.filter((s) => s.status === 'EXPIRED').length
        }}</strong
        ><span>已过期</span>
      </div>
      <RouterLink class="text-link" to="/admin/subscriptions"
        >查看订阅 <ArrowRight :size="15"
      /></RouterLink>
    </div>
    <OrderDialog :order="selected" admin @close="selected = undefined" />
  </section>
</template>

<style scoped>
.overview-demo {
  margin-bottom: 16px;
}
</style>
