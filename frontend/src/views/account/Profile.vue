<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ShieldCheck, LogOut, ArrowUpRight } from '@lucide/vue'
import { mock, CURRENT_USER } from '../../stores/mock'
const email = ref(mock.state.notificationEmail)
const security = ref(false)
function save() {
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value) ||
    email.value.length > 254
  )
    return ElMessage.error('请填写有效的通知邮箱')
  mock.state.notificationEmail = email.value
  ElMessage.success('已保存到当前 Mock 会话')
}
</script>
<template>
  <section class="profile-section">
    <div class="page-heading">
      <div>
        <span class="eyebrow">ACCOUNT</span>
        <h1>个人中心</h1>
      </div>
    </div>
    <div v-if="mock.state.signedIn" class="panel profile-panel">
      <div class="profile-user">
        <span class="avatar large">林</span>
        <div>
          <h2>{{ mock.customer(CURRENT_USER)?.name }}</h2>
          <span class="muted">演示账户</span>
        </div>
      </div>
      <ElForm label-position="top" @submit.prevent="save"
        ><ElFormItem label="登录邮箱"
          ><ElInput
            :model-value="mock.customer(CURRENT_USER)?.email"
            disabled
            aria-label="登录邮箱" /></ElFormItem
        ><ElFormItem label="通知邮箱"
          ><ElInput
            v-model="email"
            type="email"
            maxlength="254"
            aria-label="通知邮箱" /></ElFormItem
        ><ElButton type="primary" native-type="submit"
          >保存通知邮箱</ElButton
        ></ElForm
      ><button class="profile-entry" @click="security = true">
        <span><ShieldCheck :size="19" />密码与安全</span
        ><ArrowUpRight :size="16" /></button
      ><button
        class="profile-entry logout"
        @click="mock.state.signedIn = false"
      >
        <span><LogOut :size="19" />退出演示账户</span>
      </button>
    </div>
    <div v-else class="panel empty-state">
      <h2>已退出演示账户</h2>
      <p class="muted">Task 1.1 使用虚构演示账户。</p>
      <ElButton type="primary" @click="mock.state.signedIn = true"
        >进入演示账户</ElButton
      >
    </div>
    <ElDialog
      v-model="security"
      title="密码与安全"
      width="420px"
      class="responsive-dialog"
      ><p>此原型未接入真实认证。密码修改将在后续认证阶段实现。</p>
      <template #footer
        ><ElButton type="primary" @click="security = false"
          >知道了</ElButton
        ></template
      ></ElDialog
    >
  </section>
</template>
