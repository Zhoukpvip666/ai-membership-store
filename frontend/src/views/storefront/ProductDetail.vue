<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { readCatalogProduct, type PublicProduct } from '../../api/catalog'
import { ApiError } from '../../api/client'
import { money } from '../../stores/format'

const props = defineProps<{ slug: string }>()
const product = ref<PublicProduct>()
const error = ref('')
const missing = ref(false)
const loading = ref(true)
let sequence = 0
const units = { DAY: '天', MONTH: '个月', YEAR: '年' } as const
const period = computed(() => {
  const unit = product.value?.servicePeriodUnit
  const count = product.value?.servicePeriodCount
  return unit && count ? count + ' ' + units[unit] : undefined
})

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
    <article v-else-if="product" class="product-card detail-card">
      <span
        :class="['badge', product.type === 'SUBSCRIPTION' ? 'blue' : 'purple']"
      >
        {{ product.type === 'SUBSCRIPTION' ? '订阅服务' : '一次性服务' }}
      </span>
      <h1>{{ product.name }}</h1>
      <p v-if="product.description" class="product-description">
        {{ product.description }}
      </p>
      <dl class="catalog-facts">
        <div>
          <dt>初始价格</dt>
          <dd>{{ money(product.priceFen) }}</dd>
        </div>
        <div>
          <dt>服务周期</dt>
          <dd>
            {{ period ?? product.termLabel }}
            <span v-if="period" class="muted"> · {{ product.termLabel }}</span>
          </dd>
        </div>
        <div
          v-if="
            product.type === 'SUBSCRIPTION' && product.renewalPriceFen !== null
          "
        >
          <dt>续费价格</dt>
          <dd>{{ money(product.renewalPriceFen) }}</dd>
        </div>
      </dl>
      <ElButton type="primary" disabled>暂未开放线上购买</ElButton>
    </article>
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
.detail-card {
  display: block;
  overflow-wrap: anywhere;
}
.detail-card h1 {
  margin: 12px 0;
}
.catalog-facts {
  display: grid;
  gap: 12px;
  margin: 20px 0;
}
.catalog-facts dt {
  font-size: 12px;
  color: #66758b;
}
.catalog-facts dd {
  margin: 4px 0 0;
}
</style>
