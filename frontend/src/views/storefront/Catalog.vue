<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, PackageOpen } from '@lucide/vue'
import { mock } from '../../stores/mock'
import { money } from '../../stores/format'
import type { Product } from '../../types'
import CheckoutDialog from '../../components/CheckoutDialog.vue'
import { auth } from '../../stores/auth'
const category = ref('ALL')
const selected = ref<Product>()
const products = computed(() =>
  mock.state.products.filter(
    (p) => p.listed && (category.value === 'ALL' || p.type === category.value),
  ),
)
const filters = [
  { value: 'ALL', text: '全部' },
  { value: 'SUBSCRIPTION', text: '订阅服务' },
  { value: 'ONE_TIME', text: '一次性服务' },
]
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">STOREFRONT</span>
        <h1>商品</h1>
      </div>
      <span class="muted">{{ products.length }} 件商品</span>
    </div>
    <div class="filter-row" role="group" aria-label="商品分类">
      <button
        v-for="item in filters"
        :key="item.value"
        :class="['filter-button', { selected: category === item.value }]"
        :aria-pressed="category === item.value"
        @click="category = item.value"
      >
        {{ item.text }}
      </button>
    </div>
    <div v-if="products.length" class="product-grid">
      <article
        v-for="product in products"
        :key="product.id"
        class="product-card"
      >
        <div class="product-info">
          <span
            :class="[
              'badge',
              product.type === 'SUBSCRIPTION' ? 'blue' : 'purple',
            ]"
            >{{
              product.type === 'SUBSCRIPTION' ? '订阅服务' : '一次性服务'
            }}</span
          >
          <h2>{{ product.name }}</h2>
          <div class="price">
            {{ money(product.priceFen)
            }}<small v-if="product.type === 'SUBSCRIPTION'"
              >/ {{ product.term }}</small
            >
          </div>
          <p class="muted">
            {{
              product.type === 'SUBSCRIPTION'
                ? '续费 ' +
                  money(product.renewalPriceFen!) +
                  ' / ' +
                  product.term
                : '一次性付费，无需续费'
            }}
          </p>
        </div>
        <ElButton
          class="buy-button"
          type="primary"
          :disabled="
            auth.state.user?.role !== 'ADMIN' || !mock.canPurchase(product)
          "
          @click="selected = product"
        >
          {{
            auth.state.user?.role !== 'ADMIN'
              ? '暂未开放线上购买'
              : product.purchaseEnabled
                ? '立即购买'
                : '暂不可购买'
          }}
          <ArrowRight
            v-if="auth.state.user?.role === 'ADMIN' && product.purchaseEnabled"
            :size="16"
          />
        </ElButton>
      </article>
    </div>
    <div v-else class="empty-state">
      <PackageOpen :size="32" />
      <p>暂无上架商品</p>
    </div>
    <CheckoutDialog :product="selected" @close="selected = undefined" />
  </section>
</template>
