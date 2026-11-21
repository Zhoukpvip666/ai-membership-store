<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router'
import { readPurchaseProduct, type PurchaseProduct } from '../../api/catalog'
import { ApiError } from '../../api/client'
import { customerOrderLocation } from '../../api/customer-orders'
import ProductFormInputs from '../../components/ProductFormInputs.vue'
import ProductSummary from '../../components/ProductSummary.vue'
import { auth } from '../../stores/auth'
import { formValueLabel } from '../../stores/format'
import { usePurchaseCheckout } from './purchase-checkout'

const props = defineProps<{ slug: string }>()
const route = useRoute()
const router = useRouter()
const product = shallowRef<PurchaseProduct>()
const {
  values,
  errors,
  message,
  phase,
  review,
  confirmed,
  reset,
  check,
  edit,
  submit,
} = usePurchaseCheckout(product)
const loading = ref(true)
const error = ref<ApiError>()
const notice = ref('')
const protectedRequest = computed(
  () => phase.value === 'submitting' || phase.value === 'uncertain',
)
const providedFields = computed(
  () =>
    product.value?.formSchema.fields.filter(
      (field) => review.value?.[field.id] !== undefined,
    ) ?? [],
)
let sequence = 0
let leaving = false

async function load(updated = false) {
  const current = ++sequence
  leaving = false
  product.value = undefined
  reset()
  notice.value = updated
    ? '商品信息已更新，请重新核对价格和服务信息后下单。'
    : ''
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

async function placeOrder() {
  const result = await submit()
  if (leaving) return
  if (result === 'changed') await load(true)
  if (result === 'unavailable') {
    product.value = undefined
    error.value = new ApiError(
      409,
      'PRODUCT_FORM_UNAVAILABLE',
      '此商品当前不可购买。',
    )
  }
  if (result === 'created' && confirmed.value) {
    await router.replace(customerOrderLocation(confirmed.value.id))
  }
}

function confirmLeave() {
  if (!protectedRequest.value) return true
  leaving = window.confirm(
    '订单结果尚未确认。离开后可能无法重试原请求，可以在我的订单核实。确定离开？',
  )
  return leaving
}

onBeforeRouteLeave((to) => {
  if (
    to.path === '/login' &&
    !auth.state.user &&
    to.query.redirect === route.fullPath
  )
    return true
  return confirmLeave()
})
onBeforeRouteUpdate(
  (to, from) => to.params.slug === from.params.slug || confirmLeave(),
)
const removeAfterEach = router.afterEach((_to, _from, failure) => {
  if (failure) leaving = false
})

function beforeUnload(event: BeforeUnloadEvent) {
  if (!protectedRequest.value) return
  event.preventDefault()
  event.returnValue = true
}

function pageHide() {
  if (!protectedRequest.value) reset()
}

watch(
  () => props.slug,
  () => load(),
  { immediate: true },
)
window.addEventListener('beforeunload', beforeUnload)
window.addEventListener('pagehide', pageHide)
onBeforeUnmount(() => {
  sequence++
  removeAfterEach()
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('pagehide', pageHide)
  reset()
})
</script>

<template>
  <section class="purchase-page" :aria-busy="loading">
    <RouterLink :to="{ name: 'catalog-product', params: { slug } }">
      返回商品详情
    </RouterLink>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status" class="muted">正在加载购买信息…</p>
    <p v-else-if="error" role="alert" class="form-error">
      <span
        v-if="error.status === 404 || error.code === 'PRODUCT_FORM_UNAVAILABLE'"
        >商品不可购买。
      </span>
      {{ error.message }}
      <ElButton
        v-if="error.status !== 404 && error.code !== 'PRODUCT_FORM_UNAVAILABLE'"
        link
        @click="load(Boolean(notice))"
        >重试</ElButton
      >
      <RouterLink v-else to="/">返回商品目录</RouterLink>
    </p>
    <div v-else-if="product" class="purchase-content">
      <ProductSummary
        :product="product"
        :price-label="phase === 'edit' ? undefined : '应付金额'"
      />
      <div v-if="phase === 'edit'" class="panel purchase-form">
        <h2>服务信息</h2>
        <ElForm label-position="top" novalidate @submit.prevent="check">
          <ProductFormInputs v-model="values" :schema="product.formSchema" />
          <ul v-if="errors.length" role="alert" class="form-error">
            <li v-for="(message, index) in errors" :key="index">
              {{ message }}
            </li>
          </ul>
          <p v-if="message" role="alert" class="form-error">{{ message }}</p>
          <ElButton type="primary" native-type="submit">检查填写信息</ElButton>
        </ElForm>
      </div>
      <section v-else class="panel purchase-form">
        <h2>核对订单</h2>
        <h3>服务信息</h3>
        <dl v-if="providedFields.length" class="review-fields">
          <template v-for="field in providedFields" :key="field.id">
            <dt>{{ field.label }}</dt>
            <dd>{{ formValueLabel(field, review?.[field.id]) }}</dd>
          </template>
        </dl>
        <p v-else class="muted">未填写服务信息。</p>
        <p v-if="phase === 'submitting'" role="status">正在提交订单…</p>
        <p v-if="phase === 'uncertain'" role="alert" class="form-error">
          订单结果尚未确认。请重试原请求，或在我的订单里核实。
        </p>
        <p v-if="confirmed" role="status">
          订单已创建。
          <RouterLink :to="customerOrderLocation(confirmed.id)"
            >查看订单详情</RouterLink
          >
        </p>
        <div v-if="!confirmed" class="review-actions">
          <ElButton
            v-if="phase === 'uncertain'"
            type="primary"
            @click="placeOrder"
          >
            重试原请求
          </ElButton>
          <template v-else>
            <ElButton :disabled="phase === 'submitting'" @click="edit"
              >返回修改</ElButton
            >
            <ElButton
              :disabled="phase === 'submitting'"
              type="primary"
              @click="placeOrder"
            >
              确认下单
            </ElButton>
          </template>
        </div>
      </section>
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
.review-fields {
  display: grid;
  gap: 6px;
}
.review-fields dt {
  font-weight: 600;
}
.review-fields dd {
  margin: 0 0 6px;
  white-space: pre-wrap;
}
.review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.review-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
@media (max-width: 720px) {
  .purchase-content {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
