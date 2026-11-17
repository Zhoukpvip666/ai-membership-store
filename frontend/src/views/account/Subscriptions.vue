<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { CalendarDays } from '@lucide/vue'
import { CURRENT_USER, mock } from '../../stores/mock'
import {
  date,
  money,
  mask,
  subscriptionLabels,
  orderLabels,
  orderDisplayStatus,
} from '../../stores/format'
import type { Subscription } from '../../types'
import CheckoutDialog from '../../components/CheckoutDialog.vue'
import OrderDialog from '../../components/OrderDialog.vue'
const props = defineProps<{ admin?: boolean }>()
const route = useRoute()
const status = ref('ALL')
const selected = ref<Subscription>()
const renewing = ref<Subscription>()
const linkedOrderId = ref<string>()
const subscriptions = computed(() =>
  mock.state.subscriptions.filter(
    (s) =>
      (props.admin || (mock.state.signedIn && s.userId === CURRENT_USER)) &&
      (!props.admin || !route.query.user || s.userId === route.query.user) &&
      (status.value === 'ALL' || s.status === status.value),
  ),
)
const linkedOrders = computed(() =>
  selected.value
    ? mock.state.orders.filter((o) => selected.value!.orderIds.includes(o.id))
    : [],
)
const linkedOrder = computed(() =>
  mock.state.orders.find((o) => o.id === linkedOrderId.value),
)
const fmt = (value: string) => date(value, mock.state.settings.timezone)
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">{{
          admin ? 'SUBSCRIPTIONS' : 'MY SUBSCRIPTIONS'
        }}</span>
        <h1>{{ admin ? '订阅管理' : '我的订阅' }}</h1>
      </div>
      <span class="muted">{{ subscriptions.length }} 项订阅</span>
    </div>
    <div v-if="admin && route.query.user" class="inline-note">
      正在查看指定用户的订阅
      <RouterLink to="/admin/subscriptions">查看全部</RouterLink>
    </div>
    <div class="filter-row" role="group" aria-label="订阅状态">
      <button
        v-for="item in [
          { value: 'ALL', label: '全部' },
          ...Object.entries(subscriptionLabels).map(([value, label]) => ({
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
    <div v-if="admin" class="panel">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>客户 / 订阅编号</th>
              <th>商品</th>
              <th>到期日期</th>
              <th>续费价格</th>
              <th>状态</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in subscriptions" :key="sub.id">
              <td>
                <strong>{{ mock.customer(sub.userId)?.name }}</strong><small
                  class="mono"
                  >{{ sub.id }}</small
                >
              </td>
              <td>{{ sub.productName }}</td>
              <td>{{ fmt(sub.expiresAt) }}</td>
              <td>
                {{
                  money(
                    mock.product(sub.productId)?.renewalPriceFen ??
                      sub.renewalPriceFen,
                  )
                }}
              </td>
              <td>
                <span
                  :class="['badge', sub.status === 'ACTIVE' ? 'green' : 'gray']"
                  >{{ subscriptionLabels[sub.status] }}</span
                >
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="selected = sub"
                  >查看详情</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!subscriptions.length" class="empty-state">
        暂无符合条件的订阅
      </div>
    </div>
    <div v-else class="subscription-list">
      <article
        v-for="sub in subscriptions"
        :key="sub.id"
        class="panel subscription-card"
      >
        <div class="subscription-top">
          <div class="subscription-icon"><CalendarDays :size="22" /></div>
          <div class="grow">
            <h2>{{ sub.productName }}</h2>
            <span class="muted">{{ mask(sub.target) }}</span>
          </div>
          <span
            :class="['badge', sub.status === 'ACTIVE' ? 'green' : 'gray']"
            >{{ subscriptionLabels[sub.status] }}</span
          >
        </div>
        <div class="subscription-bottom">
          <div>
            <span class="muted">到期日期</span
            ><strong>{{ fmt(sub.expiresAt) }}</strong>
          </div>
          <div>
            <span class="muted">续费价格</span
            ><strong
              >{{
                money(
                  mock.product(sub.productId)?.renewalPriceFen ??
                    sub.renewalPriceFen,
                )
              }}<small>
                / {{ mock.product(sub.productId)?.term }}</small
              ></strong
            >
          </div>
          <div class="subscription-actions">
            <ElButton @click="selected = sub">详情</ElButton
            ><ElButton
              v-if="mock.canRenew(sub)"
              type="primary"
              plain
              @click="renewing = sub"
              >续费</ElButton
            ><span v-else class="muted">{{
              sub.status === 'TERMINATED' ? '订阅已终止' : '暂不支持续费'
            }}</span>
          </div>
        </div>
      </article>
      <div v-if="!subscriptions.length" class="panel empty-state">
        <CalendarDays :size="30" />
        <p>
          {{
            mock.state.signedIn
              ? '暂无符合条件的订阅'
              : '请在个人中心进入演示账户'
          }}
        </p>
      </div>
    </div>
    <ElDialog
      :model-value="Boolean(selected)"
      title="订阅详情"
      width="600px"
      class="responsive-dialog"
      @close="selected = undefined"
    >
      <template v-if="selected"
        ><div class="detail-title">
          <div>
            <h3>{{ selected.productName }}</h3>
            <span class="mono muted">{{ selected.id }}</span>
          </div>
          <span
            :class="['badge', selected.status === 'ACTIVE' ? 'green' : 'gray']"
            >{{ subscriptionLabels[selected.status] }}</span
          >
        </div>
        <dl class="detail-grid">
          <div>
            <dt>目标邮箱</dt>
            <dd>{{ mask(selected.target) }}</dd>
          </div>
          <div>
            <dt>开始日期</dt>
            <dd>{{ fmt(selected.startedAt) }}</dd>
          </div>
          <div>
            <dt>到期日期</dt>
            <dd>{{ fmt(selected.expiresAt) }}</dd>
          </div>
          <div>
            <dt>当前续费价格</dt>
            <dd>
              {{
                money(
                  mock.product(selected.productId)?.renewalPriceFen ??
                    selected.renewalPriceFen,
                )
              }}
            </dd>
          </div>
        </dl>
        <p class="inline-note">
          {{
            mock.canRenew(selected)
              ? '续费生成独立模拟订单，不自动扣费或延长到期日。'
              : '续费已停用；当前订阅权益与到期日期仍然保留。'
          }}
        </p>
        <h4>关联订单</h4>
        <div v-for="order in linkedOrders" :key="order.id" class="linked-row">
          <button class="text-button mono" @click="linkedOrderId = order.id">
            {{ order.id }}</button><span
            >{{ order.kind === 'RENEWAL' ? '续费' : '首次购买' }} ·
            {{ orderLabels[orderDisplayStatus(order)] }}</span
          >
        </div>
        <p v-if="!linkedOrders.length" class="muted">
          暂无关联模拟订单
        </p></template
      >
    </ElDialog>
    <OrderDialog
      :order="linkedOrder"
      :admin="admin"
      @close="linkedOrderId = undefined"
    />
    <CheckoutDialog
      :product="renewing ? mock.product(renewing.productId) : undefined"
      :subscription="renewing"
      @close="renewing = undefined"
    />
  </section>
</template>
