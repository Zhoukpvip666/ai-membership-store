<script setup lang="ts">
import {
  LayoutDashboard,
  Package,
  ReceiptText,
  CalendarDays,
  UsersRound,
  Settings2,
  ArrowUpRight,
  FlaskConical,
} from '@lucide/vue'
import Brand from '../components/Brand.vue'
import { mock } from '../stores/mock'
const nav = [
  { path: '/admin', text: '经营概览', icon: LayoutDashboard },
  { path: '/admin/products', text: '商品管理', icon: Package },
  { path: '/admin/orders', text: '订单管理', icon: ReceiptText },
  { path: '/admin/subscriptions', text: '订阅管理', icon: CalendarDays },
  { path: '/admin/users', text: '用户管理', icon: UsersRound },
  { path: '/admin/settings', text: '系统设置', icon: Settings2 },
]
</script>
<template>
  <div class="admin-shell">
    <header class="topbar admin-topbar">
      <div class="admin-brand">
        <Brand /><span class="console-label">管理控制台</span>
      </div>
      <div class="header-actions">
        <RouterLink class="console-link" to="/"
          >返回商店 <ArrowUpRight :size="14" /></RouterLink
        ><span class="owner-email">{{ mock.state.settings.ownerEmail }}</span
        ><span class="avatar owner">管</span>
      </div>
    </header>
    <aside class="admin-sidebar">
      <span class="sidebar-caption">工作空间</span>
      <nav aria-label="管理导航">
        <RouterLink
          v-for="item in nav"
          :key="item.path"
          :to="item.path"
          exact-active-class="active"
          ><component :is="item.icon" :size="19" /><span>{{
            item.text
          }}</span></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <span class="online-dot"></span> 本地原型环境
        <small>v0.1 · Task 1.1</small>
      </div>
    </aside>
    <main class="admin-main">
      <div class="demo-notice">
        <FlaskConical :size="15" /><span
          >Mock 演示 · 管理入口无真实鉴权，所有操作均为本地模拟</span
        ><span class="demo-pill">MOCK</span>
      </div>
      <RouterView />
      <footer class="page-footer">
        统一管理控制台 <span>·</span> 本地演示环境
      </footer>
    </main>
  </div>
</template>
