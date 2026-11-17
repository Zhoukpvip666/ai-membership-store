import { reactive } from 'vue'
import { api, ApiError, type Account } from '../api/client'

const state = reactive({
  user: null as Account | null,
  checked: false,
  error: '',
})
let pending: Promise<void> | undefined
window.addEventListener('membership:unauthenticated', () => {
  state.user = null
})

export const auth = {
  state,
  async load(force = false) {
    if (state.checked && !force) return
    pending ??= (async () => {
      try {
        state.user = (await api<{ user: Account }>('/auth/me')).user
        state.error = ''
      } catch (error) {
        state.user = null
        state.error =
          error instanceof ApiError && error.status === 401
            ? ''
            : '无法连接本地 API，请确认后端已启动'
      } finally {
        state.checked = true
        pending = undefined
      }
    })()
    await pending
  },
  async login(email: string, password: string) {
    state.user = (
      await api<{ user: Account }>('/auth/login', 'POST', { email, password })
    ).user
    state.checked = true
    state.error = ''
    return state.user
  },
  async logout() {
    await api('/auth/logout', 'POST', {})
    state.user = null
    state.checked = true
  },
}
