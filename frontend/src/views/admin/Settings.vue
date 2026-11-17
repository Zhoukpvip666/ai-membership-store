<script setup lang="ts">
import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { mock } from '../../stores/mock'
const form = reactive({ ...mock.state.settings })
function save() {
  if (!form.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ownerEmail))
    return ElMessage.error('请填写店铺名称与有效邮箱')
  Object.assign(mock.state.settings, form, { name: form.name.trim() })
  ElMessage.success('设置已保存到当前 Mock 会话')
}
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">SETTINGS</span>
        <h1>系统设置</h1>
      </div>
    </div>
    <ElForm class="settings-form" label-position="top" @submit.prevent="save"
      ><div class="panel settings-panel">
        <h2>基本设置</h2>
        <div class="form-grid">
          <ElFormItem label="店铺名称"
            ><ElInput
              v-model="form.name"
              maxlength="30"
              aria-label="店铺名称" /></ElFormItem
          ><ElFormItem label="店主 / 通知邮箱"
            ><ElInput
              v-model="form.ownerEmail"
              type="email"
              maxlength="254"
              aria-label="店主 / 通知邮箱"
          /></ElFormItem>
        </div>
        <ElFormItem label="业务时区"
          ><ElSelect v-model="form.timezone" aria-label="业务时区"
            ><ElOption
              label="北京时间 · Asia/Shanghai"
              value="Asia/Shanghai" /><ElOption
              label="UTC"
              value="UTC" /><ElOption
              label="洛杉矶 · America/Los_Angeles"
              value="America/Los_Angeles" /></ElSelect
        ></ElFormItem>
      </div>
      <div class="panel settings-panel">
        <h2>邮件通知偏好</h2>
        <div class="toggle-row">
          <div>
            <strong>订单完成通知</strong><small>演示偏好，不发送邮件</small>
          </div>
          <ElSwitch v-model="form.notifyEmail" aria-label="订单完成通知" />
        </div>
        <div class="toggle-row">
          <div>
            <strong>订阅到期提醒</strong><small>演示偏好，不运行提醒任务</small>
          </div>
          <ElSwitch v-model="form.notifyExpiry" aria-label="订阅到期提醒" />
        </div>
      </div>
      <div class="panel settings-panel">
        <h2>服务配置状态</h2>
        <div class="toggle-row">
          <span>支付服务</span><span class="badge gray">未接入 · Mock</span>
        </div>
        <div class="toggle-row">
          <span>SMTP 邮件服务</span><span class="badge gray">未接入</span>
        </div>
        <p class="muted">密钥及凭据由部署环境管理。</p>
      </div>
      <ElButton type="primary" native-type="submit"
        >保存本地设置</ElButton
      ></ElForm
    >
  </section>
</template>
