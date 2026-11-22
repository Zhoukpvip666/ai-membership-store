<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowRight, ChevronLeft, CircleAlert, LoaderCircle } from '@lucide/vue'
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
    <RouterLink class="catalog-back" :to="{ name: 'catalog' }">
      <ChevronLeft :size="18" aria-hidden="true" /> 返回商品目录
    </RouterLink>
    <div v-if="loading" role="status" class="store-state store-surface">
      <span class="store-state-icon"
        ><LoaderCircle :size="22" class="store-spinner" aria-hidden="true"
      /></span>
      <p>正在加载商品…</p>
    </div>
    <div v-else-if="error" role="alert" class="store-state store-surface">
      <span class="store-state-icon"
        ><CircleAlert :size="22" aria-hidden="true"
      /></span>
      <h2>{{ missing ? '商品不存在' : '暂时无法加载商品' }}</h2>
      <p v-if="!missing">{{ error }}</p>
      <ElButton v-if="!missing" plain @click="load">重试</ElButton>
    </div>
    <ProductSummary v-else-if="product" :product="product" variant="detail">
      <ElButton
        type="primary"
        class="catalog-purchase-button store-primary-button"
        @click="$router.push({ name: 'customer-purchase', params: { slug } })"
      >
        立即购买 <ArrowRight :size="18" aria-hidden="true" />
      </ElButton>
    </ProductSummary>
  </section>
</template>

<style scoped>
.catalog-detail {
  display: grid;
  gap: var(--store-space-4);
}
.catalog-back {
  display: inline-flex;
  align-items: center;
  gap: var(--store-space-1);
  min-height: 44px;
  justify-self: start;
  border-radius: var(--store-radius-sm);
  color: var(--store-secondary);
  font-weight: 600;
}
.catalog-back:hover {
  color: var(--store-blue);
}
.catalog-purchase-button {
  width: 100%;
  min-height: 48px;
  font-size: 15px;
  font-weight: 650;
}
.catalog-purchase-button :deep(span) {
  gap: var(--store-space-2);
}
@media (max-width: 767px) {
  .catalog-detail {
    gap: var(--store-space-2);
  }
}
</style>
