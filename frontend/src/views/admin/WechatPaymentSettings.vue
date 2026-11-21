<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import {
  readWechatPayment,
  readWechatQr,
  setWechatPayment,
  uploadWechatQr,
  type WechatPaymentSettings,
} from '../../api/wechat-payment'

const configuration = shallowRef<WechatPaymentSettings>()
const fileInput = ref<HTMLInputElement>()
const selected = shallowRef<File>()
const preview = ref('')
const busy = ref(true)
const error = ref('')
let mounted = true

function clearPreview() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
}

async function refreshPreview(value: WechatPaymentSettings) {
  configuration.value = value
  clearPreview()
  if (value.imageUrl) {
    const image = await readWechatQr()
    if (mounted) preview.value = URL.createObjectURL(image)
  }
}

async function apply(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '收款设置操作失败'
  } finally {
    busy.value = false
  }
}

const load = () => apply(async () => refreshPreview(await readWechatPayment()))

function selectFile(event: Event) {
  selected.value = (event.target as HTMLInputElement).files?.[0]
  error.value = ''
}

function upload() {
  const image = selected.value
  if (!image) return
  if (image.size > 2 * 1024 * 1024) {
    error.value = '收款码图片不得超过 2 MB'
    return
  }
  return apply(async () => {
    const saved = await uploadWechatQr(image)
    selected.value = undefined
    if (fileInput.value) fileInput.value.value = ''
    ElMessage.success('收款码已保存')
    await refreshPreview(saved)
  })
}

function toggle(value: boolean | string | number) {
  const enabled = value === true
  return apply(async () => {
    configuration.value = await setWechatPayment(enabled)
    ElMessage.success(enabled ? '微信收款已启用' : '微信收款已停用')
  })
}

onMounted(load)
onBeforeUnmount(() => {
  mounted = false
  clearPreview()
})
</script>

<template>
  <section class="panel settings-panel wechat-payment" aria-label="收款设置">
    <h2>收款设置</h2>
    <ElSwitch
      :model-value="configuration?.enabled ?? false"
      aria-label="启用微信收款"
      active-text="启用微信收款"
      :disabled="
        busy ||
        !configuration ||
        (!configuration.enabled && !configuration.imageUrl)
      "
      @change="toggle"
    />
    <p v-if="busy && !configuration" role="status">正在读取收款设置…</p>
    <img
      v-if="preview"
      :src="preview"
      alt="当前微信收款码"
      class="wechat-qr-preview"
    />
    <p v-else-if="configuration && !configuration.imageUrl" class="muted">
      尚未上传微信收款码。上传后可启用。
    </p>
    <div v-if="configuration" class="wechat-qr-upload">
      <label for="wechat-qr-file">微信收款码图片</label>
      <input
        id="wechat-qr-file"
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        :disabled="busy"
        @change="selectFile"
      />
      <small class="muted"
        >支持 PNG、JPEG、WebP，最大 2 MB，宽高均不超过 2048 像素。</small
      >
      <ElButton :disabled="busy || !selected" @click="upload">
        {{ configuration.imageUrl ? '更换收款码' : '上传收款码' }}
      </ElButton>
    </div>
    <p v-if="error" class="form-error" role="alert">
      {{ error }}
      <ElButton link :disabled="busy" @click="load">重新加载收款设置</ElButton>
    </p>
  </section>
</template>

<style scoped>
.wechat-payment {
  margin-top: 20px;
}
.wechat-qr-preview {
  display: block;
  width: min(240px, 100%);
  height: auto;
  margin: 12px 0;
}
.wechat-qr-upload {
  display: grid;
  gap: 8px;
  justify-items: start;
  margin-top: 12px;
}
.wechat-qr-upload input {
  max-width: 100%;
}
</style>
