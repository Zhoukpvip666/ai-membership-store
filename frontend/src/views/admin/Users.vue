<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search } from '@lucide/vue'
import { mock } from '../../stores/mock'
import { date, mask } from '../../stores/format'
import type { Customer } from '../../types'
const search = ref('')
const selected = ref<Customer>()
const users = computed(() =>
  mock.state.customers.filter((u) =>
    (u.name + u.email)
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
)
const orderCount = (id: string) =>
  mock.state.orders.filter((o) => o.userId === id).length
const subscriptionCount = (id: string) =>
  mock.state.subscriptions.filter((s) => s.userId === id).length
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">CUSTOMERS</span>
        <h1>用户管理</h1>
      </div>
      <span class="muted">{{ users.length }} 位用户</span>
    </div>
    <div class="panel">
      <div class="toolbar">
        <span class="section-label">客户列表</span
        ><ElInput
          v-model="search"
          :prefix-icon="Search"
          class="search-input"
          aria-label="搜索用户"
          placeholder="搜索姓名或邮箱"
          clearable
        />
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>注册日期</th>
              <th>订单</th>
              <th>订阅</th>
              <th>状态</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td>
                <strong>{{ user.name }}</strong><small>{{
                  mask(user.email)
                }}</small>
              </td>
              <td>{{ date(user.createdAt, mock.state.settings.timezone) }}</td>
              <td>{{ orderCount(user.id) }}</td>
              <td>{{ subscriptionCount(user.id) }}</td>
              <td>
                <span :class="['badge', user.active ? 'green' : 'gray']">{{
                  user.active ? '正常' : '已停用'
                }}</span>
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="selected = user"
                  >查看详情</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!users.length" class="empty-state">未找到用户</div>
      <div class="table-footer">全部为虚构演示账户</div>
    </div>
    <ElDialog
      :model-value="Boolean(selected)"
      title="用户详情"
      width="480px"
      class="responsive-dialog"
      @close="selected = undefined"
      ><template v-if="selected"
        ><div class="profile-user">
          <span class="avatar">{{ selected.name.slice(0, 1) }}</span>
          <div>
            <h3>{{ selected.name }}</h3>
            <span class="muted">{{ selected.email }}</span>
          </div>
        </div>
        <dl class="detail-grid">
          <div>
            <dt>注册日期</dt>
            <dd>
              {{ date(selected.createdAt, mock.state.settings.timezone) }}
            </dd>
          </div>
          <div>
            <dt>账号状态</dt>
            <dd>{{ selected.active ? '正常' : '已停用' }}</dd>
          </div>
          <div>
            <dt>订单数量</dt>
            <dd>{{ orderCount(selected.id) }}</dd>
          </div>
          <div>
            <dt>订阅数量</dt>
            <dd>{{ subscriptionCount(selected.id) }}</dd>
          </div>
        </dl>
        <div class="button-row">
          <RouterLink
            :to="{ path: '/admin/orders', query: { user: selected.id } }"
            class="outline-link"
            >查看该用户订单</RouterLink
          ><RouterLink
            :to="{ path: '/admin/subscriptions', query: { user: selected.id } }"
            class="outline-link"
            >查看该用户订阅</RouterLink
          >
        </div></template
      ></ElDialog
    >
  </section>
</template>
