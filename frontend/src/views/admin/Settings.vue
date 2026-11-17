<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { settings } from '../../stores/settings'
const form = reactive({
  storeName: '',
  ownerEmail: '',
  timezone: 'Asia/Shanghai',
})
const loading = ref(true),
  busy = ref(false),
  error = ref('')
async function load() {
  loading.value = true
  error.value = ''
  try {
    const value = await settings.load(true)
    Object.assign(form, {
      storeName: value.storeName,
      ownerEmail: value.ownerEmail,
      timezone: value.timezone,
    })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
async function save() {
  busy.value = true
  error.value = ''
  try {
    await settings.save({ ...form })
    ElMessage.success('设置已保存至数据库')
  } catch (e) {
    error.value = (e as Error).message
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
        <span class="eyebrow">SETTINGS</span>
        <h1>系统设置</h1>
      </div>
    </div>
    <p v-if="error" class="form-error" role="alert">
      {{ error }} <ElButton link @click="load">重新加载</ElButton>
    </p>
    <ElForm
      class="settings-form"
      label-position="top"
      :disabled="loading || busy"
      @submit.prevent="save"
      ><div class="panel settings-panel">
        <h2>基本设置</h2>
        <div class="form-grid">
          <ElFormItem label="店铺名称"
            ><ElInput
              v-model="form.storeName"
              maxlength="80"
              aria-label="店铺名称" /></ElFormItem
          ><ElFormItem label="管理员通知邮箱"
            ><ElInput
              v-model="form.ownerEmail"
              type="email"
              maxlength="254"
              aria-label="管理员通知邮箱"
          /></ElFormItem>
        </div>
        <ElFormItem label="业务时区"
          ><ElInput
            v-model="form.timezone"
            maxlength="64"
            aria-label="业务时区"
            placeholder="Asia/Shanghai"
        /></ElFormItem>
        <p class="muted">
          使用 IANA 时区名称，例如
          Asia/Shanghai、UTC、America/Los_Angeles。时间戳以 UTC
          保存，页面日期按此设置展示。
        </p>
        <p class="inline-note">
          通知邮箱不改变管理员登录邮箱，本阶段不发送任何邮件。
        </p>
      </div>
      <ElButton type="primary" native-type="submit" :loading="busy"
        >保存设置</ElButton
      >
    </ElForm>
  </section>
</template>
