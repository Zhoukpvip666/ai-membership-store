<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Search, ReceiptText } from '@lucide/vue'
import { CURRENT_USER, mock } from '../../stores/mock'
import {
  date,
  mask,
  money,
  orderLabels,
  refundLabels,
} from '../../stores/format'
import type { Order } from '../../types'
import OrderDialog from '../../components/OrderDialog.vue'
const props = defineProps<{ admin?: boolean }>()
const route = useRoute()
const search = ref('')
const status = ref('ALL')
const selected = ref<Order>()
const orders = computed(() =>
  mock.state.orders.filter(
    (o) =>
      (props.admin || (mock.state.signedIn && o.userId === CURRENT_USER)) &&
      (!props.admin || !route.query.user || o.userId === route.query.user) &&
      (status.value === 'ALL' || o.status === status.value) &&
      (
        o.id +
        o.productName +
        mock.customer(o.userId)?.email +
        mock.customer(o.userId)?.name
      )
        .toLowerCase()
        .includes(search.value.toLowerCase().trim()),
  ),
)
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">{{ admin ? 'ORDERS' : 'MY ORDERS' }}</span>
        <h1>{{ admin ? '订单管理' : '我的订单' }}</h1>
      </div>
      <span class="muted">{{ orders.length }} 笔订单</span>
    </div>
    <div v-if="admin && route.query.user" class="inline-note">
      正在查看指定用户的订单
      <RouterLink to="/admin/orders">查看全部</RouterLink>
    </div>
    <div class="panel">
      <div class="toolbar">
        <div class="filter-row" role="group" aria-label="订单状态">
          <button
            v-for="item in [
              { value: 'ALL', label: '全部' },
              ...Object.entries(orderLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]"
            :key="item.value"
            :class="['filter-button', { selected: status === item.value }]"
            :aria-pressed="status === item.value"
            @click="status = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <ElInput
          v-model="search"
          class="search-input"
          :prefix-icon="Search"
          :placeholder="admin ? '搜索订单号、客户或商品' : '搜索订单号或商品'"
          aria-label="搜索订单"
          clearable
        />
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>商品 / 订单号</th>
              <th v-if="admin">客户</th>
              <th>下单时间</th>
              <th>金额</th>
              <th>状态</th>
              <th v-if="admin">退款</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in orders" :key="order.id">
              <td>
                <strong>{{ order.productName }}</strong><small class="mono"
                  >{{ order.id }}
                  <span v-if="order.kind === 'RENEWAL'">· 续费</span></small
                >
              </td>
              <td v-if="admin">
                {{ mock.customer(order.userId)?.name
                }}<small>{{
                  mask(mock.customer(order.userId)?.email ?? '')
                }}</small>
              </td>
              <td>{{ date(order.createdAt, mock.state.settings.timezone) }}</td>
              <td class="strong">{{ money(order.amountFen) }}</td>
              <td>
                <span
                  :class="[
                    'badge',
                    order.status === 'COMPLETED'
                      ? 'green'
                      : order.status === 'REFUNDED'
                        ? 'gray'
                        : 'amber',
                  ]"
                  >{{ orderLabels[order.status] }}</span
                >
              </td>
              <td v-if="admin">{{ refundLabels[order.refund] }}</td>
              <td class="align-right">
                <ElButton link type="primary" @click="selected = order"
                  >查看详情</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!orders.length" class="empty-state">
        <ReceiptText :size="30" />
        <p>
          {{
            mock.state.signedIn || admin
              ? '暂无符合条件的订单'
              : '请在个人中心进入演示账户'
          }}
        </p>
      </div>
      <div class="table-footer">共 {{ orders.length }} 条 · Mock 数据</div>
    </div>
    <OrderDialog
      :order="selected"
      :admin="admin"
      @close="selected = undefined"
    />
  </section>
</template>
