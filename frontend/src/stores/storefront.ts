import { reactive } from 'vue'
import { api } from '../api/client'

const state = reactive({ storeName: 'AI 会员商店' })
let request = 0

export const storefront = {
  state,
  async load() {
    const current = ++request
    try {
      const { storeName } = await api<{ storeName: string }>(
        '/storefront/config',
      )
      if (current === request) state.storeName = storeName
    } catch {
      // Keep the last known name, or the default on a fresh visit.
    }
  },
}
