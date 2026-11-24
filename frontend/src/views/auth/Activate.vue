<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '../../api/client'
import Brand from '../../components/Brand.vue'
import { auth } from '../../stores/auth'
const route = useRoute()
const router = useRouter()
const token = ref('')
const email = ref('')
const password = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('邀请链接无效，请联系管理员获取新链接')
watch(
  () => route.hash,
  (hash) => {
    if (!hash) return
    token.value = hash.slice(1)
    password.value = ''
    confirmation.value = ''
    email.value = ''
    error.value = /^[A-Za-z0-9_-]{43}$/.test(token.value)
      ? ''
      : '邀请链接无效，请联系管理员获取新链接'
    // Fragments never reach server logs; also clear them for reused page components.
    void router.replace('/activate')
  },
  { immediate: true },
)
async function activate() {
  if (busy.value || !/^[A-Za-z0-9_-]{43}$/.test(token.value)) return
  error.value = ''
  if (password.value !== confirmation.value) {
    error.value = '两次密码输入不一致'
    return
  }
  busy.value = true
  const submittedToken = token.value
  try {
    await auth.register(email.value, password.value, submittedToken)
    if (token.value === submittedToken) await router.replace('/profile')
  } catch (cause) {
    if (token.value !== submittedToken) return
    if (cause instanceof ApiError && cause.code === 'NETWORK_ERROR') {
      error.value =
        '网络连接异常，注册结果尚未确认。你可以尝试用该邮箱和密码登录。'
    } else {
      error.value =
        cause instanceof Error ? cause.message : '暂时无法注册，请稍后重试。'
    }
  } finally {
    password.value = ''
    confirmation.value = ''
    busy.value = false
  }
}
</script>
<template>
  <main class="auth-shell">
    <div class="panel auth-panel">
      <Brand />
      <h1>通过邀请注册</h1>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <ElForm
        v-if="/^[A-Za-z0-9_-]{43}$/.test(token)"
        label-position="top"
        :disabled="busy"
        @submit.prevent="activate"
      >
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
          >注册并登录</ElButton
        >
      </ElForm>
      <RouterLink to="/login" class="outline-link">前往登录</RouterLink>
    </div>
  </main>
</template>
