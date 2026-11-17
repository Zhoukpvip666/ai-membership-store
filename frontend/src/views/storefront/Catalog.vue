<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { PackageOpen } from '@lucide/vue'
import { auth } from '../../stores/auth'
import { money } from '../../stores/format'
import { readProducts, type Product } from '../../api/products'
import ProductFormPreview from '../../components/ProductFormPreview.vue'
const category = ref('ALL'),
  page = ref(1),
  total = ref(0),
  loading = ref(false),
  error = ref('')
const products = ref<Product[]>([]),
  selected = ref<Product>()
const filters = [
  { value: 'ALL', text: '全部' },
  { value: 'SUBSCRIPTION', text: '订阅服务' },
  { value: 'ONE_TIME', text: '一次性服务' },
]
async function load() {
  if (auth.state.user?.role !== 'ADMIN') return
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      archived: 'ACTIVE',
      listed: 'true',
      page: String(page.value),
      pageSize: '20',
    })
    if (category.value !== 'ALL') query.set('type', category.value)
    const result = await readProducts(query)
    products.value = result.items
    total.value = result.total
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function filter(value: string) {
  category.value = value
  page.value = 1
  void load()
}
onMounted(load)
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">STOREFRONT</span>
        <h1>商品</h1>
      </div>
      <span v-if="auth.state.user?.role === 'ADMIN'" class="muted"
        >{{ total }} 件商品 · 管理员预览</span
      >
    </div>
    <template v-if="auth.state.user?.role === 'ADMIN'">
      <div class="filter-row" role="group" aria-label="商品分类">
        <button
          v-for="item in filters"
          :key="item.value"
          :class="['filter-button', { selected: category === item.value }]"
          :aria-pressed="category === item.value"
          @click="filter(item.value)"
        >
          {{ item.text }}
        </button>
      </div>
      <p v-if="error" role="alert" class="form-error">
        {{ error }} <ElButton link @click="load">重试</ElButton>
      </p>
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
              }}<small>/ {{ product.termLabel }}</small>
            </div>
            <p class="muted">
              {{
                product.renewalPriceFen === null
                  ? '一次性付费，无需续费'
                  : '续费 ' + money(product.renewalPriceFen)
              }}
            </p>
            <p class="product-description">{{ product.description }}</p>
          </div>
          <ElButton class="buy-button" type="primary" disabled
            >暂未开放线上购买</ElButton
          ><ElButton class="preview-button" @click="selected = product"
            >预览表单</ElButton
          >
        </article>
      </div>
      <div v-else-if="!loading && !error" class="empty-state">
        <PackageOpen :size="32" />
        <p>暂无上架商品</p>
      </div>
      <ElPagination
        v-if="total > 20"
        v-model:current-page="page"
        :total="total"
        :page-size="20"
        layout="prev, pager, next"
        @current-change="load"
      />
    </template>
    <div v-else class="panel empty-state">
      商品目录暂未对客户开放。管理员可在控制台管理和预览商品，本阶段不开放下单。
    </div>
    <ElDialog
      :model-value="Boolean(selected)"
      title="商品表单预览"
      width="600px"
      class="responsive-dialog"
      @close="selected = undefined"
      ><template v-if="selected"
        ><h2>{{ selected.name }}</h2>
        <ProductFormPreview :schema="selected.formSchema" /></template
    ></ElDialog>
  </section>
</template>
