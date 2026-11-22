<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  ArrowRight,
  CircleAlert,
  Layers2,
  LoaderCircle,
  Package,
  PackageOpen,
  Search,
} from '@lucide/vue'
import { productPeriod } from '../../components/product-period'
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
  <section class="catalog">
    <header class="catalog-heading">
      <h1>商品</h1>
      <p>浏览订阅与一次性服务，查看价格和服务周期。</p>
    </header>

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
            <div class="catalog-card-meta">
              <span class="store-product-icon" :data-type="product.type">
                <Layers2
                  v-if="product.type === 'SUBSCRIPTION'"
                  :size="22"
                  aria-hidden="true"
                />
                <Package v-else :size="22" aria-hidden="true" />
              </span>
              <span class="store-type" :data-type="product.type">
                {{
                  product.type === 'SUBSCRIPTION' ? '订阅服务' : '一次性服务'
                }}
              </span>
            </div>
            <div class="catalog-card-info">
              <h2>{{ product.name }}</h2>
              <p v-if="product.description" class="product-description">
                {{ product.description }}
              </p>
            </div>
            <div class="catalog-pricing">
              <div class="catalog-price">
                <strong>{{ money(product.priceFen) }}</strong>
                <span>{{ productPeriod(product).text }}</span>
              </div>
              <p
                v-if="
                  product.type === 'SUBSCRIPTION' &&
                  product.renewalPriceFen !== null
                "
                class="catalog-renewal"
              >
                续费 {{ money(product.renewalPriceFen) }}
              </p>
            </div>
            <RouterLink
              :to="{ name: 'catalog-product', params: { slug: product.slug } }"
              class="catalog-product-link"
              :aria-label="'查看详情：' + product.name"
            >
              查看详情 <ArrowRight :size="16" aria-hidden="true" />
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
.catalog-heading {
  margin-bottom: var(--store-space-6);
}
.catalog-heading h1 {
  margin: 0;
  font-size: clamp(28px, 3.25vw, 40px);
  font-weight: 720;
  line-height: 1.18;
}
.catalog-heading p {
  margin: var(--store-space-2) 0 0;
  color: var(--store-secondary);
  line-height: 1.6;
}
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
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  gap: var(--store-space-4);
  padding: clamp(var(--store-space-4), 2vw, var(--store-space-6));
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
.catalog-card-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--store-space-2);
}
.catalog-card-info h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.35;
}
.catalog-card-info .product-description {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin: var(--store-space-2) 0 0;
  color: var(--store-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.catalog-pricing {
  min-height: 61px;
}
.catalog-price {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: var(--store-space-2);
  color: var(--store-text);
  font-variant-numeric: tabular-nums;
}
.catalog-price strong {
  font-size: clamp(24px, 2.5vw, 29px);
  line-height: 1.2;
  letter-spacing: -0.025em;
  font-weight: 740;
}
.catalog-price span,
.catalog-renewal {
  color: var(--store-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.catalog-renewal {
  margin: var(--store-space-1) 0 0;
}
.catalog-product-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  border-top: 1px solid var(--store-line);
  padding-top: var(--store-space-2);
  color: var(--store-blue);
  font-weight: 650;
  transition: color var(--store-motion);
}
.catalog-product-link:hover {
  color: var(--store-blue-hover);
  text-decoration: underline;
  text-underline-offset: 3px;
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
  .catalog-heading {
    margin-bottom: var(--store-space-4);
  }
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
  .product-card {
    gap: var(--store-space-3);
  }
  .catalog-pricing {
    min-height: 0;
  }
}
</style>
