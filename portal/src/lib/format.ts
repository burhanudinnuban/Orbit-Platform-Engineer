/** "just now", "42s ago", "3m ago", "5h ago", "2d ago", or a date for older timestamps. */
export function relativeTime(
  iso?: string | null,
  now: number = Date.now()
): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

/** "0s", "12s", "1m 12s", "2h 5m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h}h ${mm}m` : `${h}h`
}

/** Duration between two ISO timestamps; an open end means "until now". */
export function duration(
  start?: string | null,
  end?: string | null,
  now: number = Date.now()
): string {
  if (!start) return '—'
  const a = Date.parse(start)
  const b = end ? Date.parse(end) : now
  if (Number.isNaN(a) || Number.isNaN(b)) return '—'
  return formatDuration(b - a)
}

export function shortSha(sha?: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

export function formatClock(unixSeconds: number, withSeconds = false): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleString()
}

/** Compact number: more decimals for small values, none for large ones. */
export function formatNumber(v: number, maxDigits = 2): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const digits = abs >= 100 ? 0 : abs >= 10 ? Math.min(1, maxDigits) : maxDigits
  return v.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function plural(
  n: number,
  singular: string,
  pluralForm = `${singular}s`
): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Strips ANSI color/cursor escape codes that CI tools print. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return url
  }
}
