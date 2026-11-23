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
    <div class="payment-grid">
      <div class="payment-code">
        <p v-if="loading" role="status">正在读取微信收款码…</p>
        <template v-else-if="qr">
          <img :src="qr" alt="微信收款二维码" class="wechat-qr" />
          <a :href="qr" download="wechat-payment-qr.png">保存二维码</a>
          <p>可在微信中扫码，或从相册识别已保存的图片。</p>
        </template>
        <p v-else>商家暂未开放扫码收款，请联系商家。</p>
      </div>
      <div class="payment-summary">
        <dl class="payment-facts">
          <div>
            <dt>应付金额</dt>
            <dd class="payment-amount">{{ money(order.amountFen) }}</dd>
          </div>
          <div>
            <dt>剩余付款时间</dt>
            <dd class="customer-countdown">{{ countdown(remaining) }}</dd>
          </div>
          <div class="payment-order-number">
            <dt>商城订单号</dt>
            <dd><OrderNumber :order-no="order.orderNo" /></dd>
          </div>
        </dl>
        <ElButton class="payment-claim" type="primary" @click="emit('claim')">
          我已付款
        </ElButton>
        <p class="payment-expiry">
          订单创建满 24
          小时仍未核实，可能自动取消。已转账但订单取消时，请联系商家线下处理。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wechat-payment {
  min-width: 0;
  border: 1px solid #cfdcf8;
  border-radius: 16px;
  background: #f4f7ff;
  padding: clamp(16px, 3vw, 24px);
}
.wechat-payment h3 {
  margin: 0 0 16px;
  font-size: 18px;
  color: #15233b;
}
.payment-grid {
  display: grid;
  grid-template-columns: minmax(0, 230px) minmax(0, 1fr);
  align-items: center;
  gap: clamp(16px, 3vw, 28px);
}
.payment-code {
  display: grid;
  justify-items: center;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid #d9e2f4;
  border-radius: 12px;
  background: #fff;
  text-align: center;
}
.payment-code p,
.payment-expiry {
  margin: 0;
  color: #495b76;
  line-height: 1.6;
  font-size: 13px;
}
.payment-code a {
  color: #1d4ed8;
  text-decoration: underline;
  text-underline-offset: 0.2em;
  font-weight: 650;
}
.wechat-qr {
  display: block;
  width: min(168px, 100%);
  height: auto;
}
.payment-summary {
  min-width: 0;
}
.payment-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px clamp(16px, 3vw, 32px);
  margin: 0 0 16px;
}
.payment-facts dt {
  margin-bottom: 4px;
  font-size: 13px;
  color: #495b76;
}
.payment-facts dd {
  margin: 0;
}
.payment-amount,
.customer-countdown {
  color: #15233b;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.payment-amount {
  font-size: clamp(28px, 4vw, 38px);
}
.customer-countdown {
  color: #254cab;
  font-size: clamp(21px, 3vw, 26px);
}
.payment-order-number {
  flex-basis: 100%;
  min-width: 0;
  color: #15233b;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
.payment-claim {
  min-height: 44px;
  min-width: min(176px, 100%);
  font-weight: 650;
}
.payment-expiry {
  margin-top: 10px;
}
@media (max-width: 640px) {
  .payment-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .payment-claim {
    width: 100%;
  }
}
</style>
