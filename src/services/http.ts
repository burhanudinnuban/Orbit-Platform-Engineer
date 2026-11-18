export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string
  ) {
    super(message)
  }
}

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  /** Return null instead of throwing on 404. */
  allow404?: boolean
}

/** Small JSON-over-HTTP helper with timeouts and readable errors. */
export async function httpJson<T>(
  url: string,
  opts: HttpOptions = {}
): Promise<T | null> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...opts.headers,
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    const cause =
      err instanceof Error
        ? err.cause instanceof Error
          ? err.cause.message
          : err.message
        : String(err)
    throw new HttpError(
      0,
      `${opts.method ?? 'GET'} ${new URL(url).origin}${new URL(url).pathname} unreachable: ${cause}`,
      ''
    )
  }
  if (res.status === 404 && opts.allow404) return null
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string }
      detail = parsed.message ?? parsed.error ?? detail
    } catch {
      // keep raw text
    }
    throw new HttpError(
      res.status,
      `${opts.method ?? 'GET'} ${new URL(url).pathname} → ${res.status}: ${detail}`,
      text
    )
  }
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

export async function httpText(
  url: string,
  opts: HttpOptions = {}
): Promise<string | null> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  }).catch((err: unknown) => {
    throw new HttpError(
      0,
      `${new URL(url).origin} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      ''
    )
  })
  if (res.status === 404 && opts.allow404) return null
  const text = await res.text()
  if (!res.ok)
    throw new HttpError(
      res.status,
      `GET ${new URL(url).pathname} → ${res.status}`,
      text
    )
  return text
}

export const basicAuth = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
