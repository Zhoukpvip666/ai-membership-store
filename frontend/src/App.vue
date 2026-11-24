<script setup lang="ts">
import { onMounted, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { storefront } from './stores/storefront'

const route = useRoute()
watchEffect(() => {
  const { storeName } = storefront.state
  document.title =
    route.meta.admin || route.path === '/admin/login'
      ? '管理控制台 · ' + storeName
      : storeName
})
onMounted(() => void storefront.load())
</script>

<template><RouterView /></template>
