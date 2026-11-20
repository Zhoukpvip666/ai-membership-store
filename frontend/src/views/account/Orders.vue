<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import AdminOrderCenter from '../admin/orders/OrderCenter.vue'
defineProps<{ admin?: boolean }>()
const CustomerOrders = defineAsyncComponent(
  () => import('./CustomerOrders.vue'),
)
</script>
<template>
  <AdminOrderCenter v-if="admin" />
  <CustomerOrders v-else />
</template>
