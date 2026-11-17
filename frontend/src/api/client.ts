export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        method === 'GET'
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-Requested-With': 'MembershipStore',
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接本地 API，请确认后端已启动')
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    if (response.status === 401)
      window.dispatchEvent(new Event('membership:unauthenticated'))
    throw new ApiError(
      response.status,
      error?.error?.code ?? 'REQUEST_FAILED',
      error?.error?.message ?? '操作失败，请稍后重试',
    )
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

export interface Account {
  id: string
  displayName: string
  loginEmail: string
  notificationEmail: string | null
  role: 'ADMIN' | 'CUSTOMER'
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DISABLED'
  activatedAt: string | null
  createdAt: string
}
export interface Invitation {
  id: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
}
export interface Customer extends Account {
  _count: { orders: number; subscriptions: number }
  invitations?: Invitation[]
}
export interface CustomerList {
  items: Customer[]
  total: number
  page: number
  pageSize: number
}
