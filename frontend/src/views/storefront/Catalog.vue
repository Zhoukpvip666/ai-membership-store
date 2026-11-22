<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  ArrowRight,
  CircleAlert,
  LoaderCircle,
  PackageOpen,
  Search,
} from '@lucide/vue'
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
  <section class="catalog" aria-label="商品目录">
    <div class="catalog-toolbar store-surface">
      <div class="catalog-filters" role="group" aria-label="商品分类">
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          :aria-pressed="category === item.value"
          @click="filter(item.value)"
        >
          {{ item.text }}
        </button>
      </div>
      <form class="catalog-search" role="search" @submit.prevent="applySearch">
        <ElInput
          v-model="searchInput"
          aria-label="搜索商品"
          placeholder="搜索商品名称"
          maxlength="120"
        >
          <template #prefix><Search :size="17" aria-hidden="true" /></template>
        </ElInput>
        <ElButton
          type="primary"
          native-type="submit"
          class="store-primary-button"
        >
          搜索
        </ElButton>
      </form>
    </div>

    <div :aria-busy="loading">
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
        <h2>商品暂时无法加载</h2>
        <p>{{ error }}</p>
        <ElButton plain @click="load">重试</ElButton>
      </div>
      <template v-else>
        <p class="catalog-count">{{ total }} 件商品</p>
        <div v-if="products.length" class="product-grid">
          <article
            v-for="product in products"
            :key="product.slug"
            class="product-card store-surface"
          >
            <RouterLink
              :to="{ name: 'catalog-product', params: { slug: product.slug } }"
              class="catalog-product-link"
              :aria-label="'查看详情：' + product.name"
              :aria-describedby="'catalog-price-' + product.slug"
            >
              <h2>{{ product.name }}</h2>
              <strong
                :id="'catalog-price-' + product.slug"
                class="catalog-price"
                >{{ money(product.priceFen) }}</strong
              >
              <ArrowRight :size="18" aria-hidden="true" />
            </RouterLink>
          </article>
        </div>
        <div v-else class="store-state store-surface">
          <span class="store-state-icon"
            ><PackageOpen :size="23" aria-hidden="true"
          /></span>
          <h2>暂无符合条件的商品</h2>
        </div>
      </template>
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
.catalog-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--store-space-4);
  padding: var(--store-space-3);
  margin-bottom: var(--store-space-5);
}
.catalog-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--store-space-1);
}
.catalog-filters button {
  min-height: 42px;
  padding-inline: var(--store-space-3);
  border: 1px solid transparent;
  border-radius: var(--store-radius-sm);
  background: transparent;
  color: var(--store-secondary);
  font-weight: 600;
  white-space: nowrap;
  transition: background-color var(--store-motion);
}
.catalog-filters button:hover,
.catalog-filters button[aria-pressed='true'] {
  background: var(--store-blue-wash);
  color: var(--store-blue-hover);
}
.catalog-filters button[aria-pressed='true'] {
  border-color: #dce7ff;
}
.catalog-search {
  display: flex;
  gap: var(--store-space-2);
  width: min(100%, 360px);
  min-width: 0;
  margin: 0;
}
.catalog-search .el-button {
  min-height: 44px;
  padding-inline: var(--store-space-4);
}
.catalog-search :deep(.el-input__wrapper) {
  border-radius: var(--store-radius-sm);
}
.catalog-search :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 2px var(--store-focus) inset;
}
.catalog-count {
  margin: 0 0 var(--store-space-3);
  color: var(--store-secondary);
  font-size: 13px;
  font-weight: 600;
}
.product-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--store-space-5);
}
.product-card {
  overflow-wrap: anywhere;
  transition:
    border-color var(--store-motion),
    box-shadow var(--store-motion);
}
.product-card:hover,
.product-card:focus-within {
  border-color: #bacbf0;
  box-shadow: var(--store-shadow-hover);
}
.catalog-product-link {
  position: relative;
  display: grid;
  grid-template-rows: 1fr auto;
  gap: var(--store-space-2);
  min-height: 110px;
  height: 100%;
  padding: var(--store-space-5) 50px var(--store-space-5) var(--store-space-5);
  border-radius: inherit;
}
.catalog-product-link h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.35;
}
.catalog-price {
  color: var(--store-text);
  font-size: clamp(23px, 2.5vw, 27px);
  font-variant-numeric: tabular-nums;
  font-weight: 740;
  line-height: 1.2;
  letter-spacing: -0.025em;
}
.catalog-product-link svg {
  position: absolute;
  inset-inline-end: var(--store-space-5);
  top: 50%;
  transform: translateY(-50%);
  color: var(--store-blue);
}
.catalog-pagination {
  justify-content: center;
  margin-top: var(--store-space-6);
}
@media (max-width: 979px) and (min-width: 768px) {
  .product-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 767px) {
  .catalog-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: var(--store-space-2);
    margin-bottom: var(--store-space-4);
  }
  .catalog-search {
    width: 100%;
  }
  .catalog-filters button {
    min-height: 44px;
  }
  .product-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--store-space-3);
  }
}
</style>
