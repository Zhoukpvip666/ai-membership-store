<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import type { Product, Subscription } from '../types'
import { mock } from '../stores/mock'
import { money } from '../stores/format'

const props = defineProps<{ product?: Product; subscription?: Subscription }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const email = ref('')
const target = ref('')
const submitting = ref(false)
const price = computed(() =>
  props.subscription
    ? (props.product?.renewalPriceFen ?? 0)
    : (props.product?.priceFen ?? 0),
)
watch(
  () => props.product,
  () => {
    email.value = mock.state.notificationEmail
    target.value = props.subscription?.target ?? ''
  },
)
async function submit() {
  if (!props.product || submitting.value) return
  submitting.value = true
  try {
    mock.checkout(
      props.product.id,
      email.value,
      target.value,
      props.subscription?.id,
    )
    ElMessage.success('已创建本地模拟订单，未进行付款')
    emit('close')
    await router.push('/orders')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    submitting.value = false
  }
}
</script>
<template>
  <ElDialog
    :model-value="Boolean(product)"
    :title="subscription ? '模拟续费' : '模拟购买'"
    width="480px"
    class="responsive-dialog"
    destroy-on-close
    @close="emit('close')"
  >
    <template v-if="product">
      <div class="checkout-summary">
        <span class="badge blue">{{
          subscription
            ? '订阅续费'
            : product.type === 'SUBSCRIPTION'
              ? '订阅服务'
              : '一次性服务'
        }}</span>
        <h3>{{ product.name }}</h3>
        <div class="price">
          {{ money(price) }}<small>/ {{ product.term }}</small>
        </div>
      </div>
      <p class="inline-note">
        商家人工处理，完成后通过邮件通知。此处仅创建模拟订单，不付款、不发送邮件。
      </p>
      <ElForm label-position="top" @submit.prevent="submit">
        <ElFormItem label="通知邮箱"
          ><ElInput
            v-model="email"
            type="email"
            maxlength="254"
            placeholder="name@example.com"
            aria-label="通知邮箱"
        /></ElFormItem>
        <ElFormItem
          v-if="product.targetField !== 'NONE'"
          :label="product.targetField === 'EMAIL' ? '服务目标邮箱' : '项目名称'"
        >
          <ElInput
            v-model="target"
            :type="product.targetField === 'EMAIL' ? 'email' : 'text'"
            maxlength="160"
            :placeholder="
              product.targetField === 'EMAIL'
                ? '用于接收服务邀请的邮箱'
                : '填写需要配置的项目名称'
            "
            :aria-label="
              product.targetField === 'EMAIL' ? '服务目标邮箱' : '项目名称'
            "
            :disabled="Boolean(subscription)"
          />
        </ElFormItem>
        <p v-if="subscription" class="muted">
          续费将生成独立模拟订单，现有到期日不会改变。
        </p>
        <div class="dialog-actions">
          <ElButton @click="emit('close')">取消</ElButton
          ><ElButton type="primary" native-type="submit" :loading="submitting"
            >创建模拟订单</ElButton
          >
        </div>
      </ElForm>
    </template>
  </ElDialog>
</template>
