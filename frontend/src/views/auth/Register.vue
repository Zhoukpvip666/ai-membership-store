<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '../../api/client'
import Brand from '../../components/Brand.vue'
import { customerRedirect } from '../../router/customer-redirect'
import { auth } from '../../stores/auth'

const route = useRoute()
const router = useRouter()
const redirect = computed(() => customerRedirect(route.query.redirect))
const loginRoute = computed(() => ({
  path: '/login',
  query: redirect.value ? { redirect: redirect.value } : {},
}))
const email = ref('')
const password = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')
const messages: Record<string, string> = {
  EMAIL_EXISTS: '该邮箱已被使用。已有账号可直接登录。',
  INVALID_INPUT: '请检查邮箱格式和密码要求。',
  RATE_LIMITED: '注册尝试过于频繁，请稍后再试。',
  NETWORK_ERROR:
    '网络连接异常，注册结果尚未确认。你可以尝试用该邮箱和密码登录。',
  ALREADY_AUTHENTICATED: '当前已登录，请先退出再注册。',
}

async function submit() {
  if (busy.value) return
  error.value = ''
  if (password.value !== confirmation.value) {
    error.value = '两次输入的密码不一致。'
    return
  }
  busy.value = true
  try {
    await auth.register(email.value, password.value)
    await router.replace(redirect.value ?? '/')
  } catch (cause) {
    const message = cause instanceof ApiError ? messages[cause.code] : null
    error.value = message || '暂时无法注册，请稍后重试。'
  } finally {
    busy.value = false
    password.value = ''
    confirmation.value = ''
  }
}
</script>

<template>
  <main class="auth-shell">
    <div class="panel auth-panel">
      <Brand />
      <h1>注册账号</h1>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <ElForm label-position="top" :disabled="busy" @submit.prevent="submit">
        <ElFormItem label="登录邮箱">
          <ElInput
            v-model="email"
            type="email"
            autocomplete="username"
            maxlength="254"
            aria-label="登录邮箱"
            required
          />
        </ElFormItem>
        <ElFormItem label="密码">
          <ElInput
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="128"
            aria-label="密码"
            aria-describedby="registration-password-hint"
            show-password
            required
          />
          <small id="registration-password-hint" class="muted">
            密码须为 12～128 个字符。
          </small>
        </ElFormItem>
        <ElFormItem label="确认密码">
          <ElInput
            v-model="confirmation"
            type="password"
            autocomplete="new-password"
            maxlength="128"
            aria-label="确认密码"
            show-password
            required
          />
        </ElFormItem>
        <ElButton
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="busy"
        >
          注册
        </ElButton>
      </ElForm>
      <div class="auth-links">
        <span
          >已有账号？<RouterLink :to="loginRoute">立即登录</RouterLink></span
        >
        <RouterLink to="/">返回商店</RouterLink>
      </div>
    </div>
  </main>
</template>
