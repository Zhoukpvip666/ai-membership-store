<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { Plus, Search } from '@lucide/vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api/client'
import {
  readProducts,
  removeProductCover,
  uploadProductCover,
  type Product,
  type ProductFormSchema,
} from '../../api/products'
import { money, parsePrice, date } from '../../stores/format'
import { settings } from '../../stores/settings'
import { productFormSchema } from '../../../../backend/src/contracts/product-form'
import ProductCover from '../../components/ProductCover.vue'
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
const editingUnknownPeriod = ref(false)
const coverImageUrl = ref<string | null>(null)
const queuedCover = ref<File>()
const coverBusy = ref(false)
const coverError = ref('')
const supportedCoverTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const maxCoverBytes = 4 * 1024 * 1024
const periodLabels = { DAY: '固定天数', MONTH: '自然月', YEAR: '自然年' }
const form = reactive({
  name: '',
  description: '',
  type: 'SUBSCRIPTION' as Product['type'],
  price: '',
  renewal: '',
  termLabel: '1 个月',
  servicePeriodUnit: null as Product['servicePeriodUnit'],
  servicePeriodCount: undefined as number | undefined,
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
  if (busy.value || coverBusy.value) return
  busy.value = true
  try {
    const current = product
      ? (await api<{ product: Product }>('/admin/products/' + product.id))
          .product
      : undefined
    editing.value = current?.id
    coverImageUrl.value = current?.coverImageUrl ?? null
    queuedCover.value = undefined
    coverError.value = ''
    editingUnknownPeriod.value = Boolean(
      current?.type === 'SUBSCRIPTION' &&
      current.servicePeriodUnit === null &&
      current.servicePeriodCount === null,
    )
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
            servicePeriodCount: current.servicePeriodCount ?? undefined,
          }
        : {
            name: '',
            description: '',
            type: 'SUBSCRIPTION',
            price: '',
            renewal: '',
            termLabel: '1 个月',
            servicePeriodUnit: null,
            servicePeriodCount: undefined,
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
function periodText(product: Product) {
  if (product.type === 'ONE_TIME') return '不适用（一次性商品）'
  return product.servicePeriodUnit !== null &&
    product.servicePeriodCount !== null
    ? `${product.servicePeriodCount} ${product.servicePeriodUnit}（${periodLabels[product.servicePeriodUnit]}）`
    : '尚未配置结构化周期'
}
function changeType() {
  if (form.type === 'ONE_TIME') {
    form.servicePeriodUnit = null
    form.servicePeriodCount = undefined
    form.renewal = ''
  }
}
async function chooseCover(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || coverBusy.value || busy.value) return
  coverError.value = ''
  if (
    !supportedCoverTypes.has(file.type) ||
    file.size === 0 ||
    file.size > maxCoverBytes
  ) {
    coverError.value = '请选择有效的 PNG、JPEG 或 WebP 图片（最多 4 MB）。'
    return
  }
  if (!editing.value) {
    queuedCover.value = file
    return
  }
  await changeCover(editing.value, file)
}

async function changeCover(id: string, file?: File) {
  if (coverBusy.value || busy.value) return
  coverBusy.value = true
  coverError.value = ''
  try {
    const result = file
      ? await uploadProductCover(id, file)
      : await removeProductCover(id)
    coverImageUrl.value = result.coverImageUrl
    queuedCover.value = undefined
    products.value = products.value.map((item) =>
      item.id === id ? { ...item, ...result } : item,
    )
    ElMessage.success(file ? '商品主图已保存' : '商品主图已删除')
  } catch (e) {
    coverError.value = (e as Error).message
  } finally {
    coverBusy.value = false
  }
}

async function save() {
  if (busy.value || coverBusy.value) return
  busy.value = true
  try {
    const schema = productFormSchema.safeParse(form.formSchema)
    if (!schema.success)
      throw new Error('请修正动态表单配置：' + schema.error.issues[0]?.message)
    const preserveUnknownPeriod =
      editingUnknownPeriod.value &&
      form.type === 'SUBSCRIPTION' &&
      form.servicePeriodUnit === null &&
      form.servicePeriodCount === undefined
    if (
      form.type === 'SUBSCRIPTION' &&
      !preserveUnknownPeriod &&
      (form.servicePeriodUnit === null ||
        form.servicePeriodCount === undefined ||
        !Number.isInteger(form.servicePeriodCount) ||
        form.servicePeriodCount < 1 ||
        form.servicePeriodCount > 2147483647)
    )
      throw new Error('请选择服务周期单位并填写正整数周期数量')
    const data = {
      name: form.name,
      description: form.description || null,
      type: form.type,
      priceFen: parsePrice(form.price),
      renewalPriceFen:
        form.type === 'SUBSCRIPTION' ? parsePrice(form.renewal) : null,
      termLabel: form.termLabel,
      // Omit the unknown legacy pair when editing unrelated fields; explicit
      // period changes always send both values. Never derive them from termLabel.
      ...(preserveUnknownPeriod
        ? {}
        : {
            servicePeriodUnit:
              form.type === 'SUBSCRIPTION' ? form.servicePeriodUnit : null,
            servicePeriodCount:
              form.type === 'SUBSCRIPTION' ? form.servicePeriodCount : null,
          }),
      sortOrder: form.sortOrder,
      listed: form.listed,
      formSchema: schema.data,
    }
    const { product: saved } = await api<{ product: Product }>(
      '/admin/products' + (editing.value ? '/' + editing.value : ''),
      editing.value ? 'PATCH' : 'POST',
      data,
    )
    if (queuedCover.value) {
      editing.value = saved.id
      coverBusy.value = true
      coverError.value = ''
      try {
        coverImageUrl.value = (
          await uploadProductCover(saved.id, queuedCover.value)
        ).coverImageUrl
        queuedCover.value = undefined
      } catch (e) {
        coverError.value = '商品已保存，主图上传失败：' + (e as Error).message
        await load()
        return
      } finally {
        coverBusy.value = false
      }
    }
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
                <small>结构化周期：{{ periodText(p) }}</small>
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
      :close-on-press-escape="!busy && !coverBusy"
      :show-close="!busy && !coverBusy"
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
            ><ElSelect
              v-model="form.type"
              aria-label="商品类型"
              @change="changeType"
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
          ><ElFormItem label="服务周期说明"
            ><ElInput
              v-model="form.termLabel"
              aria-label="服务周期"
              maxlength="40"
          /></ElFormItem>
          <template v-if="form.type === 'SUBSCRIPTION'">
            <ElFormItem label="服务周期单位">
              <ElSelect
                v-model="form.servicePeriodUnit"
                aria-label="服务周期单位"
                placeholder="请选择周期单位"
                clearable
                @clear="form.servicePeriodUnit = null"
              >
                <ElOption
                  v-for="(label, unit) in periodLabels"
                  :key="unit"
                  :label="label + '（' + unit + '）'"
                  :value="unit"
                />
              </ElSelect>
            </ElFormItem>
            <ElFormItem label="服务周期数量">
              <ElInputNumber
                v-model="form.servicePeriodCount"
                aria-label="服务周期数量"
                :min="1"
                :max="2147483647"
                :step="1"
                :precision="0"
                step-strictly
              />
            </ElFormItem>
          </template>
          <ElFormItem label="排序"
            ><ElInputNumber
              v-model="form.sortOrder"
              :min="0"
              :max="2147483647"
              :precision="0"
              aria-label="商品排序"
          /></ElFormItem>
        </div>
        <p
          v-if="form.type === 'SUBSCRIPTION' && editingUnknownPeriod"
          class="inline-note"
          role="status"
        >
          尚未配置结构化周期。可以先修改其他信息；补录前不能用于创建新的订阅订单。
        </p>
        <p class="muted">
          价格以整数人民币分保存。服务周期说明仅供展示；结构化周期独立配置，不从说明推断。
          DAY 表示固定天数，MONTH / YEAR 表示自然周期。
        </p>
        <div class="toggle-row">
          <div>
            <span>商品上架</span
            ><small>仅控制商城展示；未上架且未归档仍可用于后续线下业务</small>
          </div>
          <ElSwitch v-model="form.listed" aria-label="商品上架" />
        </div>
        <section class="admin-cover" aria-label="商品主图">
          <h3>商品主图</h3>
          <div class="admin-cover-content">
            <ProductCover
              class="admin-cover-preview"
              :src="coverImageUrl"
              alt="当前商品主图"
            />
            <div class="admin-cover-fields">
              <label for="product-cover-file">{{
                coverImageUrl ? '更换主图' : '上传主图'
              }}</label>
              <input
                id="product-cover-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                :disabled="busy || coverBusy"
                @change="chooseCover"
              />
              <small>PNG、JPEG、WebP，最大 4 MB。</small>
              <p v-if="queuedCover" class="muted">
                待上传：{{ queuedCover.name }}
                <ElButton
                  v-if="editing"
                  link
                  type="primary"
                  :disabled="busy || coverBusy"
                  @click="changeCover(editing, queuedCover)"
                  >重试上传</ElButton
                >
                <ElButton
                  link
                  :disabled="busy || coverBusy"
                  @click="queuedCover = undefined"
                  >移除</ElButton
                >
              </p>
              <p v-else-if="!editing" class="muted">保存商品后上传所选图片。</p>
              <p v-if="coverBusy" role="status" class="muted">
                正在处理商品主图…
              </p>
              <p v-if="coverError" class="form-error" role="alert">
                {{ coverError }}
              </p>
              <ElButton
                v-if="coverImageUrl && editing"
                link
                type="danger"
                :disabled="busy || coverBusy"
                @click="changeCover(editing)"
                >删除主图</ElButton
              >
            </div>
          </div>
        </section>
        <ProductFormEditor v-model="form.formSchema" />
        <div class="dialog-actions">
          <ElButton :disabled="busy || coverBusy" @click="visible = false"
            >取消</ElButton
          ><ElButton
            type="primary"
            native-type="submit"
            :loading="busy"
            :disabled="coverBusy"
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
        <ProductCover
          class="admin-cover-preview"
          :src="detail.coverImageUrl"
          alt="当前商品主图" />
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
            <dt>服务周期说明</dt>
            <dd>{{ detail.termLabel }}</dd>
          </div>
          <div>
            <dt>结构化服务周期</dt>
            <dd>{{ periodText(detail) }}</dd>
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

<style scoped>
.admin-cover {
  border: 1px solid #e0e5ef;
  border-radius: 10px;
  padding: 14px;
  margin: 16px 0;
}
.admin-cover h3 {
  font-size: 15px;
  margin: 0 0 10px;
}
.admin-cover-content {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
}
.admin-cover-preview {
  width: min(132px, 100%);
  border-radius: 8px;
}
.admin-cover-fields {
  flex: 1 1 220px;
  min-width: 0;
  display: grid;
  justify-items: start;
  gap: 6px;
  overflow-wrap: anywhere;
}
.admin-cover-fields input {
  max-width: 100%;
}
.admin-cover-fields p {
  margin: 0;
}
</style>
