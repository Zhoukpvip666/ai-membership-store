<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Brand from '../../components/Brand.vue'
import { auth } from '../../stores/auth'
import { isCustomerRedirect } from '../../router/customer-redirect'
const props = defineProps<{ admin?: boolean }>()
const route = useRoute()
const router = useRouter()
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const user = await auth.login(email.value, password.value)
    if (props.admin && user.role !== 'ADMIN') {
      await auth.logout()
      error.value = '该账户不是管理员，请使用客户登录入口'
      return
    }
    const target =
      typeof route.query.redirect === 'string' ? route.query.redirect : ''
    const allowed =
      user.role === 'ADMIN'
        ? target.startsWith('/admin') && !target.startsWith('/admin/login')
        : isCustomerRedirect(target)
    await router.replace(
      allowed ? target : user.role === 'ADMIN' ? '/admin/users' : '/profile',
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录失败'
  } finally {
    password.value = ''
    busy.value = false
  }
}
</script>
<template>
  <main class="auth-shell">
    <div class="panel auth-panel">
      <Brand />
      <h1>{{ admin ? '管理员登录' : '客户登录' }}</h1>
      <p class="muted">本地管理工具 · 仅限本机访问</p>
      <p v-if="error || auth.state.error" class="form-error" role="alert">
        {{ error || auth.state.error }}
      </p>
      <ElForm label-position="top" @submit.prevent="submit">
        <ElFormItem label="登录邮箱"
          ><ElInput
            v-model="email"
            type="email"
            autocomplete="username"
            maxlength="254"
            aria-label="登录邮箱"
            required
        /></ElFormItem>
        <ElFormItem label="密码"
          ><ElInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            maxlength="128"
            aria-label="密码"
            show-password
            required
        /></ElFormItem>
        <ElButton type="primary" native-type="submit" :loading="busy"
          >登录</ElButton
        >
      </ElForm>
      <div class="auth-links">
        <RouterLink :to="admin ? '/login' : '/admin/login'">{{
          admin ? '客户登录' : '管理员登录'
        }}</RouterLink><RouterLink to="/">返回商店</RouterLink>
      </div>
      <p v-if="!admin" class="muted">
        客户账户由管理员创建，请先通过邀请链接激活。本站不提供公开注册。
      </p>
    </div>
  </main>
</template>
