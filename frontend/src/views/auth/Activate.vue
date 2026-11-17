<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Brand from '../../components/Brand.vue'
import { api } from '../../api/client'
const route = useRoute()
const router = useRouter()
const token = ref('')
const password = ref('')
const confirmation = ref('')
const busy = ref(false)
const activated = ref(false)
const error = ref('邀请链接无效，请联系管理员获取新链接')
watch(
  () => route.hash,
  (hash) => {
    if (!hash) return
    token.value = hash.slice(1)
    password.value = ''
    confirmation.value = ''
    activated.value = false
    busy.value = false
    error.value = /^[A-Za-z0-9_-]{43}$/.test(token.value)
      ? ''
      : '邀请链接无效，请联系管理员获取新链接'
    // Fragments never reach server logs; also clear them for reused page components.
    void router.replace('/activate')
  },
  { immediate: true },
)
async function activate() {
  if (busy.value) return
  error.value = ''
  if (password.value !== confirmation.value) {
    error.value = '两次密码输入不一致'
    return
  }
  busy.value = true
  const submittedToken = token.value
  try {
    await api('/auth/activate', 'POST', {
      token: submittedToken,
      password: password.value,
    })
    if (token.value === submittedToken) activated.value = true
  } catch (cause) {
    if (token.value === submittedToken)
      error.value = cause instanceof Error ? cause.message : '激活失败'
  } finally {
    if (token.value === submittedToken) {
      password.value = ''
      confirmation.value = ''
      busy.value = false
    }
  }
}
</script>
<template>
  <main class="auth-shell">
    <div class="panel auth-panel">
      <Brand />
      <h1>激活客户账户</h1>
      <p class="inline-note">
        localhost / 127.0.0.1
        邀请链接只能在运行本项目的本机访问，不能从其他设备打开。本系统不会发送邮件。
      </p>
      <div v-if="activated" role="status">
        <h2>账户激活成功</h2>
        <p>现在可以使用登录邮箱和刚设置的密码登录。</p>
        <RouterLink to="/login" class="outline-link">前往登录</RouterLink>
      </div>
      <template v-else>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <ElForm v-if="token" label-position="top" @submit.prevent="activate">
          <ElFormItem label="设置密码"
            ><ElInput
              v-model="password"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              aria-label="设置密码"
              required
              show-password
          /></ElFormItem>
          <ElFormItem label="确认密码"
            ><ElInput
              v-model="confirmation"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              aria-label="确认密码"
              required
              show-password
          /></ElFormItem>
          <p class="muted">
            密码需为 12～128 字符。邀请有效期 7 天，且只能使用一次。
          </p>
          <ElButton type="primary" native-type="submit" :loading="busy"
            >激活账户</ElButton
          >
        </ElForm>
      </template>
    </div>
  </main>
</template>
