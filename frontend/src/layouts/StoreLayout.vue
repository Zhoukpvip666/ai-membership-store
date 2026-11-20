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
import { onMounted } from 'vue'
import { settings } from '../stores/settings'
onMounted(() => {
  if (auth.state.user?.role === 'ADMIN') void settings.load().catch(() => {})
})
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
          <RouterLink class="console-link" to="/admin"
            >管理控制台 <ArrowUpRight :size="14" /></RouterLink
          ><RouterLink to="/profile" class="avatar" aria-label="个人中心">{{
            auth.state.user?.username?.slice(0, 1) || '我'
          }}</RouterLink>
        </div>
      </div>
    </header>
    <main class="store-main">
      <div class="demo-notice">
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
