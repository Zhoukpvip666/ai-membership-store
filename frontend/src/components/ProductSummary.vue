<script setup lang="ts">
import { computed } from 'vue'
import type { PublicProduct } from '../api/catalog'
import { money } from '../stores/format'

const props = defineProps<{ product: PublicProduct; priceLabel?: string }>()
const units = { DAY: '天', MONTH: '个月', YEAR: '年' } as const
const period = computed(() => {
  const { servicePeriodUnit: unit, servicePeriodCount: count } = props.product
  return unit && count ? count + ' ' + units[unit] : undefined
})
</script>

<template>
  <article class="product-card detail-card">
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
        <dt>{{ priceLabel ?? '初始价格' }}</dt>
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
    <slot />
  </article>
</template>

<style scoped>
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
