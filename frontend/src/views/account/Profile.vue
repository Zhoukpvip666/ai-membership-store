<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { auth } from '../../stores/auth'
const router = useRouter()
const error = ref('')
async function logout() {
  try {
    await auth.logout()
    await router.replace('/login')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '退出失败'
  }
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
    <div v-if="auth.state.user" class="panel profile-panel">
      <div class="profile-user">
        <span class="avatar large">{{
          (
            auth.state.user.username ||
            auth.state.user.loginEmail.split('@')[0]!
          ).slice(0, 1)
        }}</span>
        <div>
          <h2>
            {{
              auth.state.user.username ||
              auth.state.user.loginEmail.split('@')[0]
            }}
          </h2>
          <span class="muted">{{
            auth.state.user.role === 'ADMIN' ? '管理员' : '客户账户'
          }}</span>
        </div>
      </div>
      <dl class="detail-grid">
        <div>
          <dt>登录邮箱</dt>
          <dd>{{ auth.state.user.loginEmail }}</dd>
        </div>
        <div>
          <dt>通知邮箱</dt>
          <dd>
            {{
              auth.state.user.notificationEmail || auth.state.user.loginEmail
            }}
          </dd>
        </div>
        <div>
          <dt>账户状态</dt>
          <dd>已激活</dd>
        </div>
      </dl>
      <p class="muted">
        在<RouterLink to="/account/orders">我的订单</RouterLink
        >查看订单和付款进度，在<RouterLink to="/subscriptions"
          >我的订阅</RouterLink
        >查看服务状态与到期时间。
      </p>
      <p v-if="error" role="alert" class="form-error">{{ error }}</p>
      <ElButton @click="logout">退出登录</ElButton>
    </div>
  </section>
</template>
