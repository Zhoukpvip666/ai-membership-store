<script setup lang="ts">
import { Layers2 } from '@lucide/vue'
import { settings } from '../stores/settings'
</script>
<template>
  <RouterLink class="brand" to="/"
    ><span class="brand-icon"><Layers2 :size="21" /></span
    ><span>{{ settings.state.value.storeName }}</span></RouterLink
  >
</template>
