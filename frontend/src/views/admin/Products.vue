<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Plus, Search } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { mock } from '../../stores/mock'
import { money, parsePrice } from '../../stores/format'
import type { Product, ProductType } from '../../types'
const search = ref('')
const editing = ref<string>()
const visible = ref(false)
const form = reactive({
  name: '',
  type: 'SUBSCRIPTION' as ProductType,
  price: '',
  renewal: '',
  term: '1 个月',
  listed: true,
  purchaseEnabled: true,
  renewalEnabled: true,
  targetField: 'EMAIL' as Product['targetField'],
})
const products = computed(() =>
  mock.state.products.filter((p) =>
    p.name.toLowerCase().includes(search.value.toLowerCase().trim()),
  ),
)
function open(product?: Product) {
  editing.value = product?.id
  Object.assign(
    form,
    product
      ? {
          ...product,
          price: String(product.priceFen / 100),
          renewal:
            product.renewalPriceFen === null
              ? ''
              : String(product.renewalPriceFen / 100),
        }
      : {
          name: '',
          type: 'SUBSCRIPTION',
          price: '',
          renewal: '',
          term: '1 个月',
          listed: true,
          purchaseEnabled: true,
          renewalEnabled: true,
          targetField: 'EMAIL',
        },
  )
  visible.value = true
}
function save() {
  try {
    mock.saveProduct(
      {
        name: form.name,
        type: form.type,
        priceFen: parsePrice(form.price),
        renewalPriceFen:
          form.type === 'SUBSCRIPTION' ? parsePrice(form.renewal) : null,
        term: form.term,
        listed: form.listed,
        purchaseEnabled: form.purchaseEnabled,
        renewalEnabled: form.renewalEnabled,
        targetField: form.targetField,
      },
      editing.value,
    )
    visible.value = false
    ElMessage.success('商品已保存到本地 Mock 状态')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">PRODUCTS</span>
        <h1>商品管理</h1>
      </div>
      <ElButton type="primary" :icon="Plus" @click="open()">添加商品</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <span class="section-label"
          >全部商品 <span class="count-pill">{{ products.length }}</span></span
        ><ElInput
          v-model="search"
          class="search-input"
          :prefix-icon="Search"
          placeholder="搜索商品名称"
          aria-label="搜索商品"
          clearable
        />
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>商品名称</th>
              <th>类型</th>
              <th>售价 / 续费价</th>
              <th>上架</th>
              <th>新购</th>
              <th>续费</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in products" :key="p.id">
              <td>
                <strong>{{ p.name }}</strong><small>{{ p.term }}</small>
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
                <ElSwitch v-model="p.listed" :aria-label="p.name + '上架'" />
              </td>
              <td>
                <ElSwitch
                  v-model="p.purchaseEnabled"
                  :aria-label="p.name + '新购'"
                />
              </td>
              <td>
                <ElSwitch
                  v-if="p.type === 'SUBSCRIPTION'"
                  v-model="p.renewalEnabled"
                  :aria-label="p.name + '续费'"
                /><span v-else class="muted">—</span>
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="open(p)">编辑</ElButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!products.length" class="empty-state">未找到商品</div>
      <div class="table-footer">
        共 {{ products.length }} 条 ·
        上架控制目录可见，新购控制购买按钮，续费控制已有订阅续费。历史订单及订阅保留。
      </div>
    </div>
    <ElDialog
      v-model="visible"
      :title="editing ? '编辑商品' : '添加商品'"
      width="540px"
      class="responsive-dialog"
    >
      <ElForm label-position="top" @submit.prevent="save">
        <ElFormItem label="商品名称"
          ><ElInput
            v-model="form.name"
            maxlength="60"
            placeholder="输入商品名称"
            aria-label="商品名称"
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
              placeholder="0.00"
              aria-label="售价（元）"
          /></ElFormItem>
          <template v-if="form.type === 'SUBSCRIPTION'"
            ><ElFormItem label="续费价格（元）"
              ><ElInput
                v-model="form.renewal"
                inputmode="decimal"
                placeholder="0.00"
                aria-label="续费价格（元）" /></ElFormItem
            ><ElFormItem label="服务周期"
              ><ElInput
                v-model="form.term"
                maxlength="30"
                aria-label="服务周期" /></ElFormItem
          ></template>
        </div>
        <ElFormItem label="购买时所需信息"
          ><ElSelect v-model="form.targetField" aria-label="购买时所需信息"
            ><ElOption label="服务目标邮箱" value="EMAIL" /><ElOption
              label="项目名称"
              value="TEXT" /><ElOption
              label="无需额外信息"
              value="NONE" /></ElSelect
        ></ElFormItem>
        <div class="toggle-row">
          <div><span>商品上架</span><small>仅控制商品目录是否可见</small></div>
          <ElSwitch v-model="form.listed" aria-label="商品上架" />
        </div>
        <div class="toggle-row">
          <div>
            <span>允许新客户购买</span
            ><small>关闭后仍展示已上架商品，购买按钮不可用</small>
          </div>
          <ElSwitch
            v-model="form.purchaseEnabled"
            aria-label="允许新客户购买"
          />
        </div>
        <div v-if="form.type === 'SUBSCRIPTION'" class="toggle-row">
          <div>
            <span>允许已有订阅续费</span
            ><small>独立于上架和新购，不改变当前订阅权益</small>
          </div>
          <ElSwitch
            v-model="form.renewalEnabled"
            aria-label="允许已有订阅续费"
          />
        </div>
        <div class="dialog-actions">
          <ElButton @click="visible = false">取消</ElButton
          ><ElButton type="primary" native-type="submit">保存商品</ElButton>
        </div>
      </ElForm>
    </ElDialog>
  </section>
</template>
