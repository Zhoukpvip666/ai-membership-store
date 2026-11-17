<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { mock } from '../stores/mock'
import {
  date,
  money,
  orderLabels,
  orderDisplayStatus,
  paymentLabel,
  fulfillmentLabels,
  refundLabels,
} from '../stores/format'
import type { Order } from '../types'

const props = defineProps<{ order?: Order; admin?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const confirm = ref<'complete' | 'refund'>()
function close() {
  confirm.value = undefined
  emit('close')
}
function action() {
  if (!props.order) return
  try {
    if (confirm.value === 'complete') mock.complete(props.order.id)
    else mock.requestRefund(props.order.id)
    ElMessage.success(
      confirm.value === 'complete'
        ? '模拟完成已记录，未发送邮件'
        : '模拟申请已记录，等待模拟回执',
    )
    confirm.value = undefined
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
function resolve(success: boolean) {
  try {
    mock.resolveRefund(props.order!.id, success)
    ElMessage.info(
      success ? '模拟退款成功，无真实资金变动' : '模拟退款失败，可重试',
    )
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
const fmt = (value: string) => date(value, mock.state.settings.timezone)
</script>
<template>
  <ElDialog
    :model-value="Boolean(order)"
    title="订单详情"
    width="620px"
    class="responsive-dialog"
    destroy-on-close
    @close="close"
  >
    <template v-if="order">
      <div class="detail-title">
        <div>
          <h3>{{ order.productName }}</h3>
          <span class="mono muted">{{ order.id }}</span>
        </div>
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
      </div>
      <dl class="detail-grid">
        <div>
          <dt>订单金额</dt>
          <dd class="strong">{{ money(order.amountFen) }}</dd>
        </div>
        <div>
          <dt>下单时间</dt>
          <dd>{{ fmt(order.createdAt) }}</dd>
        </div>
        <div>
          <dt>通知邮箱</dt>
          <dd>{{ order.contactEmail }}</dd>
        </div>
        <div>
          <dt>服务周期 / 类型</dt>
          <dd>
            {{ order.term }} / {{ order.kind === 'RENEWAL' ? '续费' : '新购' }}
          </dd>
        </div>
        <div v-if="order.target">
          <dt>服务信息</dt>
          <dd>{{ order.target }}</dd>
        </div>
        <div>
          <dt>付款状态（模拟）</dt>
          <dd>{{ paymentLabel(order) }}</dd>
        </div>
        <div>
          <dt>履约状态（模拟）</dt>
          <dd>{{ fulfillmentLabels[order.fulfillment] }}</dd>
        </div>
        <div v-if="admin">
          <dt>退款状态（模拟）</dt>
          <dd>{{ refundLabels[order.refund] }}</dd>
        </div>
      </dl>
      <h4>订单动态</h4>
      <ol class="timeline">
        <li v-for="(event, index) in order.timeline" :key="index">
          <span>{{ event.label }}</span><small>{{ fmt(event.at) }}</small>
        </li>
      </ol>
      <template v-if="admin">
        <div v-if="order.refund === 'PROCESSING'" class="simulation-box">
          <strong>模拟退款处理中</strong>
          <p>选择模拟结果，仅改变本地演示状态。</p>
          <div class="button-row">
            <ElButton type="primary" @click="resolve(true)"
              >模拟回执成功</ElButton
            ><ElButton @click="resolve(false)">模拟回执失败</ElButton>
          </div>
        </div>
        <div
          v-else-if="order.status === 'PENDING' && order.paid"
          class="dialog-actions"
        >
          <ElButton type="danger" plain @click="confirm = 'refund'"
            >模拟申请退款</ElButton
          ><ElButton type="primary" @click="confirm = 'complete'"
            >模拟确认已完成</ElButton
          >
        </div>
        <p v-else-if="!order.paid" class="inline-note">
          未确认付款的模拟订单不可完成或退款。
        </p>
      </template>
      <p class="dialog-footnote">
        本地 Mock 数据 · 无真实付款、退款、资金结算或邮件操作
      </p>
    </template>
  </ElDialog>
  <ElDialog
    :model-value="Boolean(confirm)"
    :title="confirm === 'complete' ? '模拟确认服务完成' : '模拟申请退款'"
    width="420px"
    class="responsive-dialog"
    @close="confirm = undefined"
  >
    <p>
      {{
        confirm === 'complete'
          ? '仅更新本地订单为已完成；不发送邮件、不变更订阅到期日、不触发资金结算。'
          : '仅创建本地退款演示，状态将进入处理中。收到模拟成功回执后才显示已退款，无真实资金变动。'
      }}
    </p>
    <template #footer
      ><ElButton @click="confirm = undefined">取消</ElButton
      ><ElButton type="primary" @click="action"
        >确认模拟操作</ElButton
      ></template
    >
  </ElDialog>
</template>
