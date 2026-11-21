<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { formatOrderNumber } from '../stores/format'

const props = defineProps<{ orderNo: string }>()
const manualCopy = ref(false)

async function copyOrderNumber() {
  try {
    await navigator.clipboard.writeText(props.orderNo)
    manualCopy.value = false
    ElMessage.success('订单号已复制')
  } catch {
    manualCopy.value = true
    ElMessage.error('复制失败，请手动复制原始订单号')
  }
}
</script>

<template>
  <span class="order-number">
    <span>{{ formatOrderNumber(orderNo) }}</span>
    <ElButton link type="primary" @click="copyOrderNumber">复制订单号</ElButton>
    <input
      v-if="manualCopy"
      :value="orderNo"
      class="raw-order-number"
      aria-label="原始订单号"
      readonly
    />
  </span>
</template>

<style scoped>
.order-number {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.raw-order-number {
  width: 100%;
  min-width: 0;
  font: inherit;
}
</style>
