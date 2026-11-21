import { reactive } from 'vue'
import { api, ApiError, type Account } from '../api/client'

const state = reactive({
  user: null as Account | null,
  checked: false,
  error: '',
})
let pending: { controller: AbortController; result: Promise<void> } | undefined

function cancelAccountRead() {
  pending?.controller.abort()
  pending = undefined
}

window.addEventListener('membership:unauthenticated', () => {
  cancelAccountRead()
  state.user = null
  state.checked = true
  state.error = ''
})

async function readAccount(signal: AbortSignal) {
  try {
    const { user } = await api<{ user: Account }>(
      '/auth/me',
      'GET',
      undefined,
      undefined,
      signal,
    )
    if (signal.aborted) return
    state.user = user
    state.error = ''
  } catch (error) {
    if (signal.aborted) return
    state.user = null
    state.error =
      error instanceof ApiError && error.status === 401
        ? ''
        : '无法连接本地 API，请确认后端已启动'
  } finally {
    if (!signal.aborted) {
      state.checked = true
      pending = undefined
    }
  }
}

export const auth = {
  state,
  async load(force = false) {
    if (state.checked && !force) return
    if (!pending) {
      const controller = new AbortController()
      pending = { controller, result: readAccount(controller.signal) }
    }
    await pending.result
  },
  async login(email: string, password: string) {
    const { user } = await api<{ user: Account }>('/auth/login', 'POST', {
      email,
      password,
    })
    cancelAccountRead()
    state.user = user
    state.checked = true
    state.error = ''
    return user
  },
  async logout() {
    await api('/auth/logout', 'POST', {})
    cancelAccountRead()
    state.user = null
    state.checked = true
  },
}
