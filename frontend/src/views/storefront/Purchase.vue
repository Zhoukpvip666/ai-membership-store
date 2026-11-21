<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { FormData } from '../../../../backend/src/contracts/form-data'
import { readPurchaseProduct, type PurchaseProduct } from '../../api/catalog'
import { ApiError } from '../../api/client'
import ProductFormInputs from '../../components/ProductFormInputs.vue'
import ProductSummary from '../../components/ProductSummary.vue'
import { purchaseErrors } from './purchase-validation'

const props = defineProps<{ slug: string }>()
const product = ref<PurchaseProduct>()
const values = ref<FormData>({})
const errors = ref<string[]>([])
const checked = ref(false)
const loading = ref(true)
const error = ref<ApiError>()
let sequence = 0

function clearInput() {
  values.value = {}
  errors.value = []
  checked.value = false
}

async function load() {
  const current = ++sequence
  product.value = undefined
  clearInput()
  error.value = undefined
  loading.value = true
  try {
    const result = await readPurchaseProduct(props.slug)
    if (current === sequence) product.value = result
  } catch (cause) {
    if (current === sequence)
      error.value =
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNAVAILABLE', '无法加载商品，请稍后重试')
  } finally {
    if (current === sequence) loading.value = false
  }
}

function check() {
  if (!product.value) return
  errors.value = purchaseErrors(product.value.formSchema, values.value)
  checked.value = !errors.value.length
}

watch(values, () => {
  errors.value = []
  checked.value = false
})
watch(() => props.slug, load, { immediate: true })
window.addEventListener('pagehide', clearInput)
onBeforeUnmount(() => {
  sequence++
  window.removeEventListener('pagehide', clearInput)
  clearInput()
})
</script>

<template>
  <section class="purchase-page" :aria-busy="loading">
    <RouterLink :to="{ name: 'catalog-product', params: { slug } }">
      返回商品详情
    </RouterLink>
    <p v-if="loading" role="status" class="muted">正在加载购买信息…</p>
    <p v-else-if="error" role="alert" class="form-error">
      {{ error.message }}
      <ElButton
        v-if="error.status !== 404 && error.code !== 'PRODUCT_FORM_UNAVAILABLE'"
        link
        @click="load"
        >重试</ElButton
      >
    </p>
    <div v-else-if="product" class="purchase-content">
      <ProductSummary :product="product" />
      <div class="panel purchase-form">
        <h2>服务信息</h2>
        <ElForm label-position="top" novalidate @submit.prevent="check">
          <ProductFormInputs v-model="values" :schema="product.formSchema" />
          <ul v-if="errors.length" role="alert" class="form-error">
            <li v-for="(message, index) in errors" :key="index">
              {{ message }}
            </li>
          </ul>
          <p v-if="checked" role="status">
            填写信息已通过检查，订单提交将在下一阶段开放。
          </p>
          <ElButton type="primary" native-type="submit">检查填写信息</ElButton>
        </ElForm>
      </div>
    </div>
  </section>
</template>

<style scoped>
.purchase-page {
  display: grid;
  gap: 16px;
  max-width: 960px;
}
.purchase-page > a {
  justify-self: start;
  color: #3468ed;
}
.purchase-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
  align-items: start;
  gap: 16px;
}
.purchase-form {
  padding: 20px;
  overflow-wrap: anywhere;
}
.purchase-form h2 {
  margin: 0 0 16px;
}
.purchase-form ul {
  padding-left: 28px;
}
@media (max-width: 720px) {
  .purchase-content {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
