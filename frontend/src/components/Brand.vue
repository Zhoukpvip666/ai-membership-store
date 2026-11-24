<script setup lang="ts">
import { Layers2 } from '@lucide/vue'
import { storefront } from '../stores/storefront'
</script>
<template>
  <RouterLink class="brand" to="/"
    ><span class="brand-icon"><Layers2 :size="21" /></span
    ><span>{{ storefront.state.storeName }}</span></RouterLink
  >
</template>
