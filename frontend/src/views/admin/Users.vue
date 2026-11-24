<script setup lang="ts">
import { adminName } from '../../stores/user-name'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@lucide/vue'
import {
  api,
  type Customer,
  type CustomerList,
  type Invitation,
} from '../../api/client'
import { date, mask } from '../../stores/format'
import { settings } from '../../stores/settings'
const search = ref('')
const status = ref('')
const page = ref(1)
const result = ref<CustomerList>({ items: [], total: 0, page: 1, pageSize: 20 })
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const formError = ref('')
const detailError = ref('')
const selected = ref<Customer>()
const formOpen = ref(false)
const editing = ref<Customer>()
const form = reactive({
  adminLabel: '',
  notificationEmail: '',
})
const statusTarget = ref<Customer>()
const reason = ref('')
const invitationUrl = ref('')
const labels = {
  PENDING_ACTIVATION: '待激活',
  ACTIVE: '正常',
  DISABLED: '已停用',
}
const activeInvitation = computed(() =>
  selected.value?.invitations?.find(
    (item) =>
      !item.usedAt &&
      !item.revokedAt &&
      new Date(item.expiresAt).getTime() > Date.now(),
  ),
)
const fmt = (value: string) => date(value, settings.state.value.timezone)
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : '操作失败，请重试'
function openStatus(user: Customer) {
  statusTarget.value = user
  reason.value = ''
  formError.value = ''
}
function changePage(delta: number) {
  page.value += delta
  void load()
}
async function load(reset = false) {
  if (reset) page.value = 1
  loading.value = true
  error.value = ''
  const query = new URLSearchParams({
    search: search.value,
    page: String(page.value),
    pageSize: '20',
  })
  if (status.value) query.set('status', status.value)
  try {
    result.value = await api<CustomerList>('/admin/users?' + query)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    loading.value = false
  }
}
async function detail(userId: string, clear = true) {
  if (clear) {
    selected.value = undefined
    invitationUrl.value = ''
  }
  detailError.value = ''
  try {
    selected.value = (
      await api<{ user: Customer }>('/admin/users/' + userId)
    ).user
  } catch (cause) {
    if (clear) error.value = message(cause)
    else detailError.value = message(cause)
  }
}
function openForm(user?: Customer) {
  editing.value = user
  Object.assign(form, {
    adminLabel: user?.adminLabel ?? '',
    notificationEmail: user?.notificationEmail ?? '',
  })
  formError.value = ''
  formOpen.value = true
}
async function save() {
  if (busy.value) return
  busy.value = true
  formError.value = ''
  try {
    const input = {
      adminLabel: form.adminLabel || null,
      ...(editing.value?.activatedAt && editing.value.loginEmail
        ? { notificationEmail: form.notificationEmail || null }
        : {}),
    }
    await api(
      '/admin/users' + (editing.value ? '/' + editing.value.id : ''),
      editing.value ? 'PATCH' : 'POST',
      editing.value ? input : { adminLabel: form.adminLabel },
    )
    formOpen.value = false
    await load()
    if (selected.value && editing.value?.id === selected.value.id)
      await detail(selected.value.id, false)
    ElMessage.success(editing.value ? '客户资料已保存' : '已创建待激活客户')
  } catch (cause) {
    formError.value = message(cause)
  } finally {
    busy.value = false
  }
}
async function changeStatus() {
  if (!statusTarget.value || busy.value) return
  busy.value = true
  formError.value = ''
  try {
    const targetId = statusTarget.value.id
    await api('/admin/users/' + targetId + '/status', 'PATCH', {
      disabled: statusTarget.value.status !== 'DISABLED',
      reason: reason.value,
    })
    statusTarget.value = undefined
    invitationUrl.value = ''
    await load()
    if (selected.value?.id === targetId) await detail(targetId, false)
    ElMessage.success('账户状态已更新')
  } catch (cause) {
    formError.value = message(cause)
  } finally {
    busy.value = false
  }
}
async function issue() {
  if (!selected.value || busy.value) return
  busy.value = true
  detailError.value = ''
  invitationUrl.value = ''
  try {
    const created = await api<{ invitation: Invitation; url: string }>(
      '/admin/users/' + selected.value.id + '/invitations',
      'POST',
      {},
    )
    invitationUrl.value = created.url
    await detail(selected.value.id, false)
    ElMessage.success('邀请已生成，旧邀请已失效')
  } catch (cause) {
    detailError.value = message(cause)
  } finally {
    busy.value = false
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(invitationUrl.value)
    ElMessage.success('邀请链接已复制')
  } catch {
    detailError.value = '无法自动复制，请从下方链接框手动复制'
  }
}
async function revoke(invitation: Invitation) {
  if (!selected.value || busy.value) return
  busy.value = true
  detailError.value = ''
  try {
    await api('/admin/invitations/' + invitation.id + '/revoke', 'POST', {})
    invitationUrl.value = ''
    await detail(selected.value.id, false)
    ElMessage.success('邀请已撤销')
  } catch (cause) {
    detailError.value = message(cause)
  } finally {
    busy.value = false
  }
}
function closeDetail() {
  selected.value = undefined
  invitationUrl.value = ''
}
onMounted(() => load())
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">CUSTOMERS</span>
        <h1>用户管理</h1>
      </div>
      <ElButton type="primary" @click="openForm()">新增客户</ElButton>
    </div>
    <p class="inline-note">
      待激活客户也可以关联订单和订阅。请手动向客户分享邀请链接。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="panel">
      <div class="toolbar customer-toolbar">
        <span class="section-label">客户列表 · {{ result.total }} 位</span>
        <ElInput
          v-model="search"
          :prefix-icon="Search"
          class="search-input"
          aria-label="搜索用户"
          placeholder="搜索备注、用户名或邮箱"
          clearable
          @keyup.enter="load(true)"
        />
        <ElSelect
          v-model="status"
          aria-label="账户状态筛选"
          style="width: 140px"
          @change="load(true)"
          ><ElOption label="全部状态" value="" /><ElOption
            v-for="(label, value) in labels"
            :key="value"
            :label="label"
            :value="value"
        /></ElSelect>
        <ElButton :loading="loading" @click="load(true)">查询</ElButton>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>创建日期</th>
              <th>订单</th>
              <th>订阅</th>
              <th>状态</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in result.items" :key="user.id">
              <td>
                <strong>{{ adminName(user) }}</strong><small>{{
                  mask(user.loginEmail)
                }}</small>
              </td>
              <td>{{ fmt(user.createdAt) }}</td>
              <td>{{ user._count.orders }}</td>
              <td>{{ user._count.subscriptions }}</td>
              <td>
                <span
                  :class="[
                    'badge',
                    user.status === 'ACTIVE'
                      ? 'green'
                      : user.status === 'PENDING_ACTIVATION'
                        ? 'blue'
                        : 'gray',
                  ]"
                  >{{ labels[user.status] }}</span
                >
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="detail(user.id)"
                  >查看详情</ElButton
                ><ElButton link type="primary" @click="openForm(user)"
                  >编辑</ElButton
                ><ElButton
                  link
                  :type="user.status === 'DISABLED' ? 'primary' : 'danger'"
                  @click="openStatus(user)"
                  >{{ user.status === 'DISABLED' ? '恢复' : '停用' }}</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!result.items.length && !loading" class="empty-state">
        未找到客户
      </div>
      <div class="table-footer pagination">
        <span>本地数据库 · 第 {{ page }} 页</span>
        <div>
          <ElButton :disabled="page <= 1 || loading" @click="changePage(-1)"
            >上一页</ElButton
          ><ElButton
            :disabled="page * 20 >= result.total || loading"
            @click="changePage(1)"
            >下一页</ElButton
          >
        </div>
      </div>
    </div>
    <ElDialog
      v-model="formOpen"
      :title="editing ? '编辑客户' : '新增客户'"
      width="480px"
      class="responsive-dialog"
      :close-on-click-modal="!busy"
      :show-close="!busy"
    >
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <ElForm label-position="top" @submit.prevent="save">
        <ElFormItem label="客户备注名称"
          ><ElInput
            v-model="form.adminLabel"
            maxlength="80"
            aria-label="客户备注名称"
            :required="!editing"
        /></ElFormItem>
        <ElFormItem
          v-if="editing?.activatedAt && editing.loginEmail"
          label="通知邮箱（可选）"
          ><ElInput
            v-model="form.notificationEmail"
            type="email"
            maxlength="254"
            aria-label="客户通知邮箱"
            placeholder="留空时使用登录邮箱"
        /></ElFormItem>
        <p class="muted">
          {{
            editing
              ? '登录邮箱由客户绑定，后台无法修改。'
              : '客户通过邀请链接自行填写邮箱和密码。'
          }}
        </p>
        <ElButton type="primary" native-type="submit" :loading="busy"
          >保存客户</ElButton
        >
      </ElForm>
    </ElDialog>
    <ElDialog
      :model-value="Boolean(statusTarget)"
      :title="statusTarget?.status === 'DISABLED' ? '恢复客户' : '停用客户'"
      width="480px"
      class="responsive-dialog"
      :close-on-click-modal="!busy"
      :show-close="!busy"
      @close="statusTarget = undefined"
    >
      <p class="muted">
        停用会撤销当前会话和未使用的邀请，不删除订单或订阅。恢复后按原激活情况回到正常或待激活状态。
      </p>
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <ElForm label-position="top" @submit.prevent="changeStatus"
        ><ElFormItem label="操作原因"
          ><ElInput
            v-model="reason"
            maxlength="500"
            aria-label="操作原因"
            required /></ElFormItem
        ><ElButton type="primary" native-type="submit" :loading="busy"
          >确认更新状态</ElButton
        ></ElForm
      >
    </ElDialog>
    <ElDialog
      :model-value="Boolean(selected)"
      title="用户详情"
      width="560px"
      class="responsive-dialog"
      :close-on-click-modal="!busy"
      :show-close="!busy"
      @close="closeDetail"
    >
      <template v-if="selected">
        <div class="profile-user">
          <span class="avatar">{{ adminName(selected).slice(0, 1) }}</span>
          <div>
            <h3>{{ adminName(selected) }}</h3>
            <span class="muted">{{ selected.loginEmail ?? '待绑定邮箱' }}</span>
          </div>
        </div>
        <dl class="detail-grid">
          <div>
            <dt>账号状态</dt>
            <dd>{{ labels[selected.status] }}</dd>
          </div>
          <div>
            <dt>通知邮箱</dt>
            <dd>
              {{
                selected.notificationEmail ?? selected.loginEmail ?? '未设置'
              }}
            </dd>
          </div>
          <div>
            <dt>订单数量</dt>
            <dd>{{ selected._count.orders }}</dd>
          </div>
          <div>
            <dt>订阅数量</dt>
            <dd>{{ selected._count.subscriptions }}</dd>
          </div>
          <div>
            <dt>创建日期</dt>
            <dd>{{ fmt(selected.createdAt) }}</dd>
          </div>
          <div>
            <dt>激活日期</dt>
            <dd>
              {{
                selected.activatedAt ? fmt(selected.activatedAt) : '尚未激活'
              }}
            </dd>
          </div>
        </dl>
        <p class="muted">
          订单和订阅目前只展示数量，真实历史页面将在后续任务接入。
        </p>
        <h3>客户邀请</h3>
        <p class="inline-note">
          链接默认 7 天有效且只能使用一次。使用 localhost
          或环回地址的链接只能在本机打开。请手动分享邀请链接，关闭详情后需重新生成才能查看。
        </p>
        <p v-if="detailError" class="form-error" role="alert">
          {{ detailError }}
        </p>
        <ElButton
          v-if="selected.status === 'PENDING_ACTIVATION'"
          type="primary"
          :loading="busy"
          @click="issue"
          >{{
            selected.invitations?.length ? '重新生成邀请链接' : '生成邀请链接'
          }}</ElButton
        >
        <p v-else class="muted">
          {{
            selected.status === 'ACTIVE'
              ? '客户已激活，无需邀请。'
              : '客户已停用，恢复为待激活状态后才可生成邀请。'
          }}
        </p>
        <div v-if="invitationUrl" class="invitation-result">
          <ElInput
            :model-value="invitationUrl"
            readonly
            aria-label="本次邀请链接"
          /><ElButton @click="copy">复制邀请链接</ElButton>
        </div>
        <p v-if="activeInvitation" class="muted">
          当前邀请有效至 {{ fmt(activeInvitation.expiresAt) }}
        </p>
        <ul class="invitation-history">
          <li v-for="invitation in selected.invitations" :key="invitation.id">
            <span
              >{{ fmt(invitation.createdAt) }} ·
              {{
                invitation.usedAt
                  ? '已使用'
                  : invitation.revokedAt
                    ? '已撤销'
                    : new Date(invitation.expiresAt).getTime() <= Date.now()
                      ? '已过期'
                      : '待使用'
              }}</span
            ><ElButton
              v-if="!invitation.usedAt && !invitation.revokedAt"
              link
              type="danger"
              :disabled="busy"
              @click="revoke(invitation)"
              >撤销邀请</ElButton
            >
          </li>
        </ul>
      </template>
    </ElDialog>
  </section>
</template>
