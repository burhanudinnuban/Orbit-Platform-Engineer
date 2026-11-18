import { getToken } from '@/features/auth/auth.session'

export const OFFLINE_MESSAGE =
  'Orbit API unreachable at /api — is `npm run dev:api` running?'

export class ApiRequestError extends Error {
  readonly status: number
  readonly details: unknown
  /** True when the API process itself could not be reached (network error or proxy failure). */
  readonly offline: boolean

  constructor(
    message: string,
    status: number,
    details?: unknown,
    offline = false
  ) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.details = details
    this.offline = offline
  }
}

export function isOffline(err: unknown): boolean {
  return err instanceof ApiRequestError && err.offline
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404
}

export function errorMessage(err: unknown): string {
  if (isOffline(err)) return OFFLINE_MESSAGE
  if (err instanceof Error) return err.message
  return String(err)
}

type Method = 'GET' | 'POST' | 'DELETE'

async function request<T>(
  method: Method,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // Only send a JSON content type with an actual body: Fastify rejects empty JSON bodies.
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiRequestError(OFFLINE_MESSAGE, 0, err, true)
  }

  const text = await res.text()
  let data: unknown
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const apiMessage =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : undefined
    // The Vite dev proxy answers 500/502/504 with a non-JSON body when the API is down.
    const offline =
      !apiMessage &&
      (res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504)
    const message = offline
      ? OFFLINE_MESSAGE
      : (apiMessage ?? `${method} ${path} failed with HTTP ${res.status}`)
    const details =
      data && typeof data === 'object' && 'details' in data
        ? (data as { details: unknown }).details
        : data
    throw new ApiRequestError(message, res.status, details, offline)
  }

  return data as T
}

/**
 * The Orbit API client. Paths are absolute (`/api/...`): Vite proxies them to
 * the API in development, and the API serves this bundle itself in production.
 */
const apiClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

export default apiClient
