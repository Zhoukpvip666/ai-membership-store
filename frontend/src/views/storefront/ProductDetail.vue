<script setup lang="ts">
import { ref, watch } from 'vue'
import { readCatalogProduct, type PublicProduct } from '../../api/catalog'
import { ApiError } from '../../api/client'
import ProductSummary from '../../components/ProductSummary.vue'

const props = defineProps<{ slug: string }>()
const product = ref<PublicProduct>()
const error = ref('')
const missing = ref(false)
const loading = ref(true)
let sequence = 0

async function load() {
  const current = ++sequence
  product.value = undefined
  error.value = ''
  missing.value = false
  loading.value = true
  try {
    const result = await readCatalogProduct(props.slug)
    if (current === sequence) product.value = result
  } catch (e) {
    if (current !== sequence) return
    missing.value = e instanceof ApiError && e.status === 404
    error.value = missing.value ? '商品不存在' : (e as Error).message
  } finally {
    if (current === sequence) loading.value = false
  }
}
watch(() => props.slug, load, { immediate: true })
</script>

<template>
  <section class="catalog-detail" :aria-busy="loading">
    <RouterLink :to="{ name: 'catalog' }">返回商品目录</RouterLink>
    <p v-if="loading" role="status" class="muted">正在加载商品…</p>
    <p v-else-if="error" role="alert" class="form-error">
      {{ error }} <ElButton v-if="!missing" link @click="load">重试</ElButton>
    </p>
    <ProductSummary v-else-if="product" :product="product">
      <ElButton
        type="primary"
        @click="$router.push({ name: 'customer-purchase', params: { slug } })"
        >立即购买</ElButton
      >
    </ProductSummary>
  </section>
</template>

<style scoped>
.catalog-detail {
  display: grid;
  gap: 16px;
  max-width: 760px;
}
.catalog-detail a {
  justify-self: start;
  color: #3468ed;
}
</style>
