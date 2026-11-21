<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { PackageOpen } from '@lucide/vue'
import { money } from '../../stores/format'
import { readCatalog, type PublicProduct } from '../../api/catalog'

const filters = [
  { value: '', text: '全部' },
  { value: 'SUBSCRIPTION', text: '订阅服务' },
  { value: 'ONE_TIME', text: '一次性服务' },
] as const
type Category = (typeof filters)[number]['value']

const pageSize = 20
const category = ref<Category>('')
const searchInput = ref('')
const search = ref('')
const page = ref(1)
const total = ref(0)
const loading = ref(true)
const error = ref('')
const products = ref<PublicProduct[]>([])
let sequence = 0

async function load() {
  const current = ++sequence
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      pageSize: String(pageSize),
    })
    if (search.value) query.set('search', search.value)
    if (category.value) query.set('type', category.value)
    const result = await readCatalog(query)
    if (current !== sequence) return
    products.value = result.items
    total.value = result.total
  } catch (e) {
    if (current === sequence) error.value = (e as Error).message
  } finally {
    if (current === sequence) loading.value = false
  }
}
function applySearch() {
  search.value = searchInput.value.trim()
  page.value = 1
  void load()
}
function filter(value: Category) {
  category.value = value
  page.value = 1
  void load()
}
function changePage(value: number) {
  page.value = value
  void load()
}
onMounted(load)
</script>

<template>
  <section>
    <div class="page-heading">
      <h1>商品</h1>
      <span v-if="!loading && !error" class="muted">{{ total }} 件商品</span>
    </div>

    <form class="catalog-search" role="search" @submit.prevent="applySearch">
      <ElInput
        v-model="searchInput"
        aria-label="搜索商品"
        placeholder="搜索商品名称"
        maxlength="120"
      />
      <ElButton type="primary" native-type="submit">搜索</ElButton>
    </form>
    <div class="filter-row" role="group" aria-label="商品分类">
      <button
        v-for="item in filters"
        :key="item.value"
        type="button"
        :class="['filter-button', { selected: category === item.value }]"
        :aria-pressed="category === item.value"
        @click="filter(item.value)"
      >
        {{ item.text }}
      </button>
    </div>

    <div :aria-busy="loading">
      <p v-if="loading" role="status" class="muted">正在加载商品…</p>
      <p v-else-if="error" role="alert" class="form-error">
        {{ error }} <ElButton link @click="load">重试</ElButton>
      </p>
      <div v-else-if="products.length" class="product-grid">
        <article
          v-for="product in products"
          :key="product.slug"
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
            <p
              v-if="
                product.type === 'SUBSCRIPTION' &&
                product.renewalPriceFen !== null
              "
              class="muted"
            >
              续费 {{ money(product.renewalPriceFen) }}
            </p>
            <p v-if="product.description" class="product-description">
              {{ product.description }}
            </p>
          </div>
          <RouterLink
            :to="{ name: 'catalog-product', params: { slug: product.slug } }"
            class="catalog-product-link"
            :aria-label="'查看详情：' + product.name"
            >查看详情</RouterLink
          >
        </article>
      </div>
      <div v-else class="empty-state">
        <PackageOpen :size="32" aria-hidden="true" />
        <p>暂无符合条件的商品</p>
      </div>
    </div>
    <ElPagination
      v-if="!loading && !error && total > pageSize"
      :current-page="page"
      :page-count="Math.min(10000, Math.ceil(total / pageSize))"
      :pager-count="5"
      layout="prev, pager, next"
      class="catalog-pagination"
      @current-change="changePage"
    />
  </section>
</template>

<style scoped>
.catalog-search {
  display: flex;
  gap: 8px;
  max-width: 440px;
  margin-bottom: 16px;
}
.product-card {
  overflow-wrap: anywhere;
}
.catalog-product-link {
  display: inline-block;
  padding: 7px 12px;
  margin-top: 12px;
  color: #3468ed;
  background: #f0f4ff;
  border-radius: 8px;
  font-size: 13px;
  white-space: nowrap;
}
.catalog-product-link:hover {
  background: #e6edff;
}
.catalog-pagination {
  margin-top: 16px;
}
</style>
