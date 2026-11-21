<script setup lang="ts">
import {
  Store,
  CalendarDays,
  ReceiptText,
  UserRound,
  ArrowUpRight,
  FlaskConical,
} from '@lucide/vue'
import Brand from '../components/Brand.vue'
import { auth } from '../stores/auth'
import { watch } from 'vue'
import { settings } from '../stores/settings'
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
</script>
<template>
  <div class="store-shell">
    <header class="topbar">
      <div class="store-header">
        <Brand />
        <nav class="desktop-nav" aria-label="用户导航">
          <RouterLink
            v-for="item in nav"
            :key="item.path"
            :to="item.path"
            :exact-active-class="'active'"
            >{{ item.text }}</RouterLink
          >
        </nav>
        <div class="header-actions">
          <RouterLink
            v-if="auth.state.user?.role === 'ADMIN'"
            class="console-link"
            to="/admin"
            >管理控制台 <ArrowUpRight :size="14" /></RouterLink
          ><RouterLink to="/profile" class="avatar" aria-label="个人中心">{{
            auth.state.user?.username?.slice(0, 1) || '我'
          }}</RouterLink>
        </div>
      </div>
    </header>
    <main class="store-main">
      <div
        v-if="!$route.meta.publicCatalog && !$route.meta.customerPurchase"
        class="demo-notice"
      >
        <FlaskConical :size="15" /><span
          >本地管理工具 · 管理员可预览真实商品，暂未开放线上购买</span
        ><span class="demo-pill">LOCAL</span>
      </div>
      <RouterView />
      <footer class="page-footer">
        AI 会员商店 <span>·</span> 本地演示环境
      </footer>
    </main>
    <nav class="bottom-nav" aria-label="移动端用户导航">
      <RouterLink
        v-for="item in nav"
        :key="item.path"
        :to="item.path"
        exact-active-class="active"
        ><component :is="item.icon" :size="21" /><span>{{
          item.short
        }}</span></RouterLink
      >
    </nav>
  </div>
</template>
