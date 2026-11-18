import { randomUUID } from 'node:crypto'

export const newId = (prefix: string) =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`

export const nowIso = () => new Date().toISOString()

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** DNS-1123 label: lowercase alphanumerics and '-', starts with a letter, ends alphanumeric. */
export const DNS_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/

/** Turn an arbitrary string into a DNS-1123 label of at most `max` characters. */
export function dnsLabel(input: string, max = 63): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
  if (!/^[a-z]/.test(s)) s = `x-${s}`
  s = s.slice(0, max).replace(/-+$/, '')
  return s || 'x'
}

/** Quote a string as one POSIX shell word. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Keep only the last `max` characters of a log, marking the cut. */
/** Run fn over items with at most `limit` calls in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++)
      out[i] = await fn(items[i]!)
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return out
}

export function tailLog(log: string, max = 512 * 1024): string {
  if (log.length <= max) return log
  return `… (${log.length - max} earlier characters truncated)\n${log.slice(log.length - max)}`
}

/** A minimal promise mutex: runs callbacks one at a time, in call order. */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.last.then(fn, fn)
    this.last = result.catch(() => undefined)
    return result
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)
            ),
          ms
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : ''
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
