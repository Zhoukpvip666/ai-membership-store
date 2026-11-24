export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const upload = body instanceof Blob
  let response: Response
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers:
        method === 'GET'
          ? {}
          : {
              'Content-Type': upload
                ? 'application/octet-stream'
                : 'application/json',
              'X-Requested-With': 'MembershipStore',
              ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
      body: upload
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '暂时无法连接商店，请稍后重试')
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    if (response.status === 401 && !signal?.aborted)
      window.dispatchEvent(new Event('membership:unauthenticated'))
    throw new ApiError(
      response.status,
      error?.error?.code ?? 'REQUEST_FAILED',
      error?.error?.message ?? '操作失败，请稍后重试',
    )
  }
  return response
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(path, method, body, idempotencyKey, signal)
  return response.status === 204 ? (undefined as T) : response.json()
}

export async function apiBlob(path: string, signal?: AbortSignal) {
  return (await request(path, 'GET', undefined, undefined, signal)).blob()
}

export interface Account {
  id: string
  username: string | null
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
  adminLabel: string | null
  _count: { orders: number; subscriptions: number }
  invitations?: Invitation[]
}
export interface CustomerList {
  items: Customer[]
  total: number
  page: number
  pageSize: number
}
