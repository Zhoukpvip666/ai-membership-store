<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  readCustomerWechatQr,
  type CustomerOrder,
} from '../../api/customer-orders'
import OrderNumber from '../../components/OrderNumber.vue'
import { money } from '../../stores/format'
import { countdown } from './customer-order-state'

const props = defineProps<{
  order: Pick<CustomerOrder, 'id' | 'amountFen' | 'orderNo'>
  remaining: number
}>()
const emit = defineEmits<{ claim: [] }>()
const qr = ref('')
const loading = ref(true)
const controller = new AbortController()
onMounted(async () => {
  try {
    const image = await readCustomerWechatQr(props.order.id, controller.signal)
    if (!controller.signal.aborted && image.type === 'image/png')
      qr.value = URL.createObjectURL(image)
  } catch {
    // A missing or disabled QR leaves manual verification available.
  } finally {
    loading.value = false
  }
})
onUnmounted(() => {
  controller.abort()
  if (qr.value) URL.revokeObjectURL(qr.value)
})
</script>

<template>
  <section aria-label="微信扫码付款" class="wechat-payment">
    <h3>微信扫码付款</h3>
    <p>
      应付金额 <strong>{{ money(order.amountFen) }}</strong>
    </p>
    <p>商城订单号 <OrderNumber :order-no="order.orderNo" /></p>
    <p v-if="loading" role="status">正在读取微信收款码…</p>
    <template v-else-if="qr">
      <img :src="qr" alt="微信收款二维码" class="wechat-qr" />
      <a :href="qr" download="wechat-payment-qr.png">保存二维码</a>
      <p>
        可在微信中扫码，或从相册识别已保存的图片。请在微信付款页面填写正确的金额和商城订单号。
      </p>
    </template>
    <p v-else>商家暂未开放扫码收款，请联系商家。</p>
    <p>
      剩余付款时间
      <strong class="customer-countdown">{{ countdown(remaining) }}</strong>
    </p>
    <p>
      订单创建满 24
      小时仍未核实，可能自动取消。已转账但订单取消时，请联系商家线下处理。
    </p>
    <ElButton type="primary" @click="emit('claim')">我已付款</ElButton>
  </section>
</template>

<style scoped>
.wechat-payment {
  background: #f3f7ff;
  border: 1px solid #d8e3ff;
  border-radius: 12px;
  padding: 0.85rem;
  margin-block: 1rem;
}
.wechat-qr {
  display: block;
  width: min(240px, 100%);
  height: auto;
  margin-block: 0.75rem;
}
.customer-countdown {
  font-variant-numeric: tabular-nums;
}
</style>
