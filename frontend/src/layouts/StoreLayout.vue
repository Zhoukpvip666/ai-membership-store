<script setup lang="ts">
import {
  Store,
  CalendarDays,
  ReceiptText,
  UserRound,
  ArrowUpRight,
} from '@lucide/vue'
import Brand from '../components/Brand.vue'
import { auth } from '../stores/auth'
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { settings } from '../stores/settings'

const route = useRoute()
watch(
  () => auth.state.user?.role,
  (role, _previous, onCleanup) => {
    if (role !== 'ADMIN') return
    void settings.load().catch(() => {})
    const refreshSession = () => {
      if (!document.hidden) void auth.load(true)
    }
    const interval = window.setInterval(refreshSession, 30_000)
    window.addEventListener('focus', refreshSession)
    document.addEventListener('visibilitychange', refreshSession)
    onCleanup(() => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshSession)
      document.removeEventListener('visibilitychange', refreshSession)
    })
  },
  { immediate: true },
)
const nav = [
  { path: '/', text: '商品', short: '商品', icon: Store },
  {
    path: '/subscriptions',
    text: '我的订阅',
    short: '订阅',
    icon: CalendarDays,
  },
  {
    path: '/account/orders',
    text: '我的订单',
    short: '订单',
    icon: ReceiptText,
  },
  { path: '/profile', text: '个人中心', short: '我的', icon: UserRound },
]
function currentPage(path: string) {
  if (route.path === path) return 'page'
  if (
    (path === '/' &&
      (route.meta.publicCatalog || route.meta.customerPurchase)) ||
    (path === '/account/orders' && route.meta.customerOrders)
  )
    return 'location'
}
</script>

<template>
  <div class="store-shell">
    <header class="store-topbar">
      <div class="store-header store-container">
        <Brand />
        <nav class="store-desktop-nav" aria-label="用户导航">
          <RouterLink
            v-for="item in nav"
            :key="item.path"
            :to="item.path"
            :aria-current="currentPage(item.path)"
          >
            {{ item.text }}
          </RouterLink>
        </nav>
        <div class="store-header-actions">
          <RouterLink
            v-if="auth.state.user?.role === 'ADMIN'"
            class="store-console-link"
            to="/admin"
          >
            管理控制台 <ArrowUpRight :size="15" aria-hidden="true" />
          </RouterLink>
          <RouterLink
            to="/profile"
            class="store-account-link"
            :aria-label="auth.state.user ? '账户' : '登录'"
          >
            <UserRound :size="17" aria-hidden="true" />
            <span v-if="!auth.state.user">登录</span>
          </RouterLink>
        </div>
      </div>
    </header>
    <main class="store-main store-container">
      <RouterView />
    </main>
    <footer class="store-footer store-container">
      <span>{{ settings.state.value.storeName }}</span>
      <span class="store-preview-label">预览环境</span>
    </footer>
    <nav class="store-bottom-nav" aria-label="移动端用户导航">
      <RouterLink
        v-for="item in nav"
        :key="item.path"
        :to="item.path"
        :aria-current="currentPage(item.path)"
      >
        <component :is="item.icon" :size="20" aria-hidden="true" />
        <span>{{ item.short }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style src="../storefront.css"></style>
