<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { Plus, Search } from '@lucide/vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api/client'
import {
  readProducts,
  type Product,
  type ProductFormSchema,
} from '../../api/products'
import { money, parsePrice, date } from '../../stores/format'
import { settings } from '../../stores/settings'
import { productFormSchema } from '../../../../backend/src/contracts/product-form'
import ProductFormEditor from '../../components/ProductFormEditor.vue'
import ProductFormPreview from '../../components/ProductFormPreview.vue'
const products = ref<Product[]>([])
const total = ref(0),
  page = ref(1),
  search = ref(''),
  type = ref('ALL'),
  archived = ref('ALL')
const loading = ref(false),
  busy = ref(false),
  error = ref(''),
  visible = ref(false)
const editing = ref<string>(),
  detail = ref<Product>()
const form = reactive({
  name: '',
  description: '',
  type: 'SUBSCRIPTION' as Product['type'],
  price: '',
  renewal: '',
  termLabel: '1 个月',
  sortOrder: 0,
  listed: false,
  formSchema: { version: 1, fields: [] } as ProductFormSchema,
})
async function load() {
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      search: search.value,
      archived: archived.value,
      page: String(page.value),
      pageSize: '20',
    })
    if (type.value !== 'ALL') query.set('type', type.value)
    const result = await readProducts(query)
    products.value = result.items
    total.value = result.total
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function filter() {
  page.value = 1
  void load()
}
async function open(product?: Product) {
  if (busy.value) return
  busy.value = true
  try {
    const current = product
      ? (await api<{ product: Product }>('/admin/products/' + product.id))
          .product
      : undefined
    editing.value = current?.id
    Object.assign(
      form,
      current
        ? {
            ...current,
            description: current.description ?? '',
            price: String(current.priceFen / 100),
            renewal:
              current.renewalPriceFen === null
                ? ''
                : String(current.renewalPriceFen / 100),
            formSchema: structuredClone(current.formSchema),
          }
        : {
            name: '',
            description: '',
            type: 'SUBSCRIPTION',
            price: '',
            renewal: '',
            termLabel: '1 个月',
            sortOrder: 0,
            listed: false,
            formSchema: { version: 1, fields: [] },
          },
    )
    visible.value = true
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
async function showDetail(product: Product) {
  try {
    detail.value = (
      await api<{ product: Product }>('/admin/products/' + product.id)
    ).product
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
async function save() {
  if (busy.value) return
  busy.value = true
  try {
    const schema = productFormSchema.safeParse(form.formSchema)
    if (!schema.success)
      throw new Error('请修正动态表单配置：' + schema.error.issues[0]?.message)
    const data = {
      name: form.name,
      description: form.description || null,
      type: form.type,
      priceFen: parsePrice(form.price),
      renewalPriceFen:
        form.type === 'SUBSCRIPTION' ? parsePrice(form.renewal) : null,
      termLabel: form.termLabel,
      sortOrder: form.sortOrder,
      listed: form.listed,
      formSchema: schema.data,
    }
    await api<Product>(
      '/admin/products' + (editing.value ? '/' + editing.value : ''),
      editing.value ? 'PATCH' : 'POST',
      data,
    )
    visible.value = false
    ElMessage.success('商品已保存至数据库')
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
async function toggleListed(product: Product, value: unknown) {
  if (busy.value) return
  busy.value = true
  try {
    const updated = (
      await api<{ product: Product }>(
        '/admin/products/' + product.id,
        'PATCH',
        { listed: Boolean(value) },
      )
    ).product
    products.value = products.value.map((item) =>
      item.id === updated.id ? updated : item,
    )
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
async function archive(product: Product) {
  try {
    await ElMessageBox.confirm(
      '归档会立即下架且不可撤销，商品不能编辑或重新上架。历史订单与已有订阅保留。',
      '归档商品',
      {
        confirmButtonText: '确认归档',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  busy.value = true
  try {
    await api('/admin/products/' + product.id + '/archive', 'POST', {})
    ElMessage.success('商品已归档')
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">PRODUCTS</span>
        <h1>商品管理</h1>
      </div>
      <ElButton type="primary" :icon="Plus" :disabled="busy" @click="open()"
        >添加商品</ElButton
      >
    </div>
    <div class="panel">
      <form class="toolbar product-filters" @submit.prevent="filter">
        <span class="section-label"
          >全部商品 <span class="count-pill">{{ total }}</span></span
        >
        <ElInput
          v-model="search"
          class="search-input"
          :prefix-icon="Search"
          placeholder="搜索商品名称"
          aria-label="搜索商品"
          clearable
        />
        <ElSelect v-model="type" aria-label="筛选商品类型" @change="filter"
          ><ElOption label="全部类型" value="ALL" /><ElOption
            label="订阅服务"
            value="SUBSCRIPTION" /><ElOption
            label="一次性服务"
            value="ONE_TIME"
        /></ElSelect>
        <ElSelect v-model="archived" aria-label="归档状态" @change="filter"
          ><ElOption label="全部状态" value="ALL" /><ElOption
            label="未归档"
            value="ACTIVE" /><ElOption label="已归档" value="ARCHIVED"
        /></ElSelect>
        <ElButton native-type="submit" :loading="loading">查询</ElButton>
      </form>
      <div v-if="error" class="inline-note form-error" role="alert">
        {{ error }} <ElButton link @click="load">重试</ElButton>
      </div>
      <div class="table-scroll" :aria-busy="loading">
        <table>
          <thead>
            <tr>
              <th>排序 / 商品名称</th>
              <th>类型</th>
              <th>售价 / 续费价</th>
              <th>上架</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in products" :key="p.id">
              <td>
                <strong>{{ p.sortOrder }} · {{ p.name }}</strong
                ><small
                  >{{ p.termLabel }}
                  <span v-if="p.archivedAt" class="badge gray"
                    >已归档</span
                  ></small
                >
              </td>
              <td>
                <span
                  :class="[
                    'badge',
                    p.type === 'SUBSCRIPTION' ? 'blue' : 'purple',
                  ]"
                  >{{ p.type === 'SUBSCRIPTION' ? '订阅' : '一次性' }}</span
                >
              </td>
              <td class="strong">
                {{ money(p.priceFen)
                }}<small>{{
                  p.renewalPriceFen === null
                    ? '无需续费'
                    : money(p.renewalPriceFen) + ' / 续费'
                }}</small>
              </td>
              <td>
                <ElSwitch
                  :model-value="p.listed"
                  :disabled="busy || Boolean(p.archivedAt)"
                  :aria-label="p.name + '上架'"
                  @update:model-value="toggleListed(p, $event)"
                />
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="showDetail(p)"
                  >详情</ElButton
                ><ElButton
                  v-if="!p.archivedAt"
                  link
                  type="primary"
                  :disabled="busy"
                  @click="open(p)"
                  >编辑</ElButton
                ><ElButton
                  v-if="!p.archivedAt"
                  link
                  type="danger"
                  :disabled="busy"
                  @click="archive(p)"
                  >归档</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!products.length && !loading && !error" class="empty-state">
        未找到商品
      </div>
      <div class="table-footer">
        共 {{ total }} 条 ·
        排序值越小越靠前。上架仅控制商城展示；未上架且未归档商品仍可供管理员后续线下业务使用。归档会下架且不可撤销。
      </div>
      <ElPagination
        v-model:current-page="page"
        :total="total"
        :page-size="20"
        layout="prev, pager, next"
        @current-change="load"
      />
    </div>
    <ElDialog
      v-model="visible"
      :title="editing ? '编辑商品' : '添加商品'"
      width="760px"
      class="responsive-dialog product-dialog"
      :close-on-click-modal="false"
    >
      <ElForm label-position="top" @submit.prevent="save">
        <ElFormItem label="商品名称"
          ><ElInput v-model="form.name" aria-label="商品名称" maxlength="120"
        /></ElFormItem>
        <ElFormItem label="商品说明"
          ><ElInput
            v-model="form.description"
            type="textarea"
            aria-label="商品说明"
            maxlength="2000"
        /></ElFormItem>
        <div class="form-grid">
          <ElFormItem label="商品类型"
            ><ElSelect v-model="form.type" aria-label="商品类型"
              ><ElOption label="订阅服务" value="SUBSCRIPTION" /><ElOption
                label="一次性服务"
                value="ONE_TIME" /></ElSelect></ElFormItem
          ><ElFormItem label="售价（元）"
            ><ElInput
              v-model="form.price"
              inputmode="decimal"
              aria-label="售价（元）"
          /></ElFormItem>
          <ElFormItem v-if="form.type === 'SUBSCRIPTION'" label="续费价格（元）"
            ><ElInput
              v-model="form.renewal"
              inputmode="decimal"
              aria-label="续费价格（元）" /></ElFormItem
          ><ElFormItem label="服务周期"
            ><ElInput
              v-model="form.termLabel"
              aria-label="服务周期"
              maxlength="40" /></ElFormItem
          ><ElFormItem label="排序"
            ><ElInputNumber
              v-model="form.sortOrder"
              :min="0"
              :max="2147483647"
              :precision="0"
              aria-label="商品排序"
          /></ElFormItem>
        </div>
        <p class="muted">
          价格以整数人民币分保存。服务周期仅作说明，不推算到期日期。
        </p>
        <div class="toggle-row">
          <div>
            <span>商品上架</span
            ><small>仅控制商城展示；未上架且未归档仍可用于后续线下业务</small>
          </div>
          <ElSwitch v-model="form.listed" aria-label="商品上架" />
        </div>
        <ProductFormEditor v-model="form.formSchema" />
        <div class="dialog-actions">
          <ElButton :disabled="busy" @click="visible = false">取消</ElButton
          ><ElButton type="primary" native-type="submit" :loading="busy"
            >保存商品</ElButton
          >
        </div>
      </ElForm>
    </ElDialog>
    <ElDialog
      :model-value="Boolean(detail)"
      title="商品详情"
      width="680px"
      class="responsive-dialog"
      @close="detail = undefined"
    >
      <template v-if="detail"
        ><h2>{{ detail.name }}</h2>
        <p class="product-description">
          {{ detail.description || '暂无说明' }}
        </p>
        <dl class="detail-grid">
          <div>
            <dt>售价</dt>
            <dd>{{ money(detail.priceFen) }}</dd>
          </div>
          <div>
            <dt>续费价格</dt>
            <dd>
              {{
                detail.renewalPriceFen === null
                  ? '无需续费'
                  : money(detail.renewalPriceFen)
              }}
            </dd>
          </div>
          <div>
            <dt>服务周期</dt>
            <dd>{{ detail.termLabel }}</dd>
          </div>
          <div>
            <dt>排序</dt>
            <dd>{{ detail.sortOrder }}</dd>
          </div>
          <div>
            <dt>创建日期</dt>
            <dd>{{ date(detail.createdAt, settings.state.value.timezone) }}</dd>
          </div>
          <div>
            <dt>商城展示</dt>
            <dd>{{ detail.listed ? '已上架' : '未上架' }}</dd>
          </div>
          <div>
            <dt>归档</dt>
            <dd>{{ detail.archivedAt ? '已归档' : '未归档' }}</dd>
          </div>
        </dl>
        <ProductFormPreview :schema="detail.formSchema"
      /></template>
    </ElDialog>
  </section>
</template>
