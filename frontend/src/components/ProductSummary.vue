<script setup lang="ts">
import { computed } from 'vue'
import ProductCover from './ProductCover.vue'
import type { PublicProduct } from '../api/catalog'
import { money } from '../stores/format'
import { productPeriod } from './product-period'

const props = defineProps<{
  product: PublicProduct
  priceLabel?: string
  variant?: 'detail'
}>()
const period = computed(() => productPeriod(props.product))
const subscription = computed(() => props.product.type === 'SUBSCRIPTION')
const renewalPrice = computed(() =>
  subscription.value && props.product.renewalPriceFen !== null
    ? money(props.product.renewalPriceFen)
    : undefined,
)
</script>

<template>
  <article v-if="variant === 'detail'" class="store-product-detail">
    <ProductCover
      class="detail-cover store-surface"
      :src="product.coverImageUrl ?? null"
      :alt="product.name"
    />
    <aside class="detail-purchase store-surface" aria-label="价格与购买">
      <header class="detail-intro">
        <span class="store-type" :data-type="product.type">
          {{ subscription ? '订阅服务' : '一次性服务' }}
        </span>
        <h1>{{ product.name }}</h1>
      </header>
      <dl class="detail-prices">
        <div class="detail-initial-price">
          <dt>初始价格</dt>
          <dd>{{ money(product.priceFen) }}</dd>
        </div>
        <div v-if="period.text">
          <dt>服务周期</dt>
          <dd>{{ period.text }}</dd>
        </div>
        <div v-if="renewalPrice">
          <dt>续费价格</dt>
          <dd>{{ renewalPrice }}</dd>
        </div>
      </dl>
      <slot />
      <p v-if="product.priceFen > 0">下单后，可在订单详情查看付款指引。</p>
    </aside>
    <section class="detail-information store-surface" aria-label="商品信息">
      <div v-if="product.description" class="detail-description">
        <h2>商品介绍</h2>
        <p class="product-description">{{ product.description }}</p>
      </div>
      <h2>服务信息</h2>
      <dl class="detail-facts">
        <div v-if="period.text">
          <dt>服务周期</dt>
          <dd>{{ period.text }}</dd>
        </div>
        <div v-if="period.note">
          <dt>周期说明</dt>
          <dd>{{ period.note }}</dd>
        </div>
        <div v-if="subscription">
          <dt>续费说明</dt>
          <dd>不会自动扣款。</dd>
        </div>
      </dl>
    </section>
  </article>

  <article v-else class="summary-compact">
    <span :class="['badge', subscription ? 'blue' : 'purple']">
      {{ subscription ? '订阅服务' : '一次性服务' }}
    </span>
    <h1>{{ product.name }}</h1>
    <p v-if="product.description" class="product-description">
      {{ product.description }}
    </p>
    <dl class="compact-facts">
      <div>
        <dt>{{ priceLabel ?? '初始价格' }}</dt>
        <dd>{{ money(product.priceFen) }}</dd>
      </div>
      <div>
        <dt>服务周期</dt>
        <dd>
          {{ period.text }}
          <span v-if="period.note" class="muted"> · {{ period.note }}</span>
        </dd>
      </div>
      <div v-if="renewalPrice">
        <dt>续费价格</dt>
        <dd>{{ renewalPrice }}</dd>
      </div>
    </dl>
    <slot />
  </article>
</template>

<style scoped>
.store-product-detail {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  grid-template-areas: 'cover purchase' 'information purchase';
  gap: var(--store-space-4) var(--store-space-6);
  align-items: start;
  overflow-wrap: anywhere;
}
.detail-cover {
  grid-area: cover;
}
.detail-intro {
  margin-bottom: var(--store-space-5);
}
.detail-intro h1 {
  margin: var(--store-space-4) 0 0;
  font-size: clamp(27px, 3.4vw, 42px);
  line-height: 1.18;
  font-weight: 730;
}
.detail-information {
  grid-area: information;
  padding: var(--store-space-6) var(--store-space-8);
}
.detail-information h2 {
  margin: 0 0 var(--store-space-2);
  font-size: 16px;
  font-weight: 700;
}
.detail-description {
  border-bottom: 1px solid var(--store-line);
  padding-bottom: var(--store-space-5);
  margin-bottom: var(--store-space-5);
}
.detail-description p {
  margin: 0;
  color: var(--store-secondary);
  font-size: 15px;
  line-height: 1.75;
}
.detail-facts {
  margin: 0;
}
.detail-facts > div {
  display: grid;
  grid-template-columns: 85px minmax(0, 1fr);
  gap: var(--store-space-3);
  padding-block: var(--store-space-2);
  line-height: 1.55;
}
.detail-facts dt,
.detail-prices dt {
  color: var(--store-secondary);
}
.detail-facts dd,
.detail-prices dd {
  margin: 0;
  font-weight: 600;
}
.detail-purchase {
  grid-area: purchase;
  padding: var(--store-space-6);
}
.detail-prices {
  margin: 0 0 var(--store-space-5);
}
.detail-prices > div:not(.detail-initial-price) {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--store-space-1) var(--store-space-4);
  margin-top: var(--store-space-3);
}
.detail-prices .detail-initial-price {
  padding-bottom: var(--store-space-4);
  margin-bottom: var(--store-space-4);
  border-bottom: 1px solid var(--store-line);
}
.detail-initial-price dd {
  margin-top: var(--store-space-2);
  font-variant-numeric: tabular-nums;
  font-size: clamp(33px, 4vw, 44px);
  line-height: 1.1;
  letter-spacing: -0.04em;
  font-weight: 750;
}
.detail-purchase p {
  margin: var(--store-space-3) 0 0;
  color: var(--store-secondary);
  font-size: 13px;
  line-height: 1.55;
}
@media (max-width: 840px) {
  .store-product-detail {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto;
    grid-template-areas: 'cover' 'purchase' 'information';
    gap: var(--store-space-3);
  }
  .detail-purchase,
  .detail-information {
    padding: var(--store-space-4);
  }
  .detail-intro h1 {
    margin-top: var(--store-space-3);
  }
  .detail-description {
    padding-bottom: var(--store-space-4);
    margin-bottom: var(--store-space-4);
  }
}
.summary-compact {
  background: #fff;
  border: 1px solid #e4e9f1;
  border-radius: 12px;
  padding: 25px 24px 21px;
  box-shadow: 0 3px 7px #27345c03;
  overflow-wrap: anywhere;
}
.summary-compact h1 {
  margin: 12px 0;
}
.summary-compact p {
  margin: 9px 0 25px;
  font-size: 12px;
}
.compact-facts {
  display: grid;
  gap: 12px;
  margin: 20px 0;
}
.compact-facts dt {
  font-size: 12px;
  color: #66758b;
}
.compact-facts dd {
  margin: 4px 0 0;
}
@media (max-width: 1023px) {
  .summary-compact {
    padding: 23px 20px;
  }
}
@media (max-width: 767px) {
  .summary-compact {
    border-radius: 10px;
    padding: 19px;
  }
  .summary-compact p {
    margin: 7px 0 0;
    font-size: 11px;
  }
}
</style>
