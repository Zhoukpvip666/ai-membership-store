<script setup lang="ts">
import { Layers2 } from '@lucide/vue'
import { mock } from '../stores/mock'
</script>
<template>
  <RouterLink class="brand" to="/"
    ><span class="brand-icon"><Layers2 :size="21" /></span
    ><span>{{ mock.state.settings.name }}</span></RouterLink
  >
</template>
