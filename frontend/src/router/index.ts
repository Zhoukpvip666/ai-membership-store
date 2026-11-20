import { createRouter, createWebHistory } from 'vue-router'
import StoreLayout from '../layouts/StoreLayout.vue'
import AdminLayout from '../layouts/AdminLayout.vue'
import { auth } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/admin/login',
      component: () => import('../views/auth/Login.vue'),
      props: { admin: true },
    },
    { path: '/login', component: () => import('../views/auth/Login.vue') },
    {
      path: '/activate',
      component: () => import('../views/auth/Activate.vue'),
    },
    {
      path: '/',
      component: StoreLayout,
      children: [
        {
          path: '',
          name: 'catalog',
          component: () => import('../views/storefront/Catalog.vue'),
        },
        {
          path: 'subscriptions',
          meta: { authenticated: true },
          component: () => import('../views/account/Subscriptions.vue'),
        },
        {
          path: 'account/orders',
          alias: '/orders',
          meta: { authenticated: true, customerOrders: true },
          component: () => import('../views/account/CustomerOrders.vue'),
        },
        {
          path: 'profile',
          meta: { authenticated: true },
          component: () => import('../views/account/Profile.vue'),
        },
      ],
    },
    {
      path: '/admin',
      meta: { admin: true },
      component: AdminLayout,
      children: [
        { path: '', component: () => import('../views/admin/Overview.vue') },
        {
          path: 'products',
          component: () => import('../views/admin/Products.vue'),
        },
        {
          path: 'orders',
          component: () => import('../views/account/Orders.vue'),
          props: { admin: true },
        },
        {
          path: 'subscriptions',
          component: () => import('../views/admin/Subscriptions.vue'),
        },
        { path: 'users', component: () => import('../views/admin/Users.vue') },
        {
          path: 'settings',
          component: () => import('../views/admin/Settings.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
router.beforeEach(async (to) => {
  await auth.load(Boolean(to.meta.admin || to.meta.authenticated))
  if (to.meta.admin && auth.state.user?.role !== 'ADMIN')
    return {
      path: auth.state.user ? '/profile' : '/admin/login',
      query: auth.state.user ? {} : { redirect: to.fullPath },
    }
  if (to.meta.authenticated && !auth.state.user)
    return { path: '/login', query: { redirect: to.fullPath } }
  if (to.meta.customerOrders && auth.state.user?.role !== 'CUSTOMER')
    return '/profile'
})
window.addEventListener('membership:unauthenticated', () => {
  if (router.currentRoute.value.meta.admin)
    void router.replace({
      path: '/admin/login',
      query: { redirect: router.currentRoute.value.fullPath },
    })
  else if (router.currentRoute.value.meta.customerOrders)
    void router.replace({
      path: '/login',
      query: { redirect: '/account/orders' },
    })
})
router.afterEach((to) => {
  document.title =
    (to.path.startsWith('/admin') ? '管理控制台' : 'AI 会员商店') +
    ' · 本地管理'
})
