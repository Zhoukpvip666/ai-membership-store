import { reactive } from 'vue'
import { api } from '../api/client'
import { storefront } from './storefront'
import type { AppSettings } from '../api/products'
const state = reactive({
  value: {
    id: 1,
    storeName: 'AI 会员商店',
    ownerEmail: '',
    timezone: 'Asia/Shanghai',
    paymentInstructions: '',
    updatedAt: '',
  } as AppSettings,
  loaded: false,
  error: '',
})
let pending: Promise<void> | undefined
export const settings = {
  state,
  async load(force = false) {
    if (state.loaded && !force) return state.value
    pending ??= (async () => {
      try {
        state.value = (
          await api<{ settings: AppSettings }>('/admin/settings')
        ).settings
        state.loaded = true
        state.error = ''
      } catch {
        state.error = '无法读取系统设置，请确认本地 API 和数据库可用'
      } finally {
        pending = undefined
      }
    })()
    await pending
    if (state.error) throw new Error(state.error)
    return state.value
  },
  async save(
    input: Pick<
      AppSettings,
      'storeName' | 'ownerEmail' | 'timezone' | 'paymentInstructions'
    >,
  ) {
    state.value = (
      await api<{ settings: AppSettings }>('/admin/settings', 'PATCH', input)
    ).settings
    state.loaded = true
    state.error = ''
    void storefront.load()
    return state.value
  },
}
