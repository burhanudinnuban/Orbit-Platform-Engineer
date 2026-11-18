import type { AlertView, Point } from '../types/contract.js'
import type { Config } from '../config/env.js'
import { httpJson, httpText } from './http.js'

interface PromResponse<T> {
  status: 'success' | 'error'
  error?: string
  data: T
}

interface MatrixResult {
  resultType: 'matrix'
  result: { metric: Record<string, string>; values: [number, string][] }[]
}

interface AlertsResult {
  alerts: {
    labels: Record<string, string>
    annotations: Record<string, string>
    state: 'pending' | 'firing'
  }[]
}

interface RulesResult {
  groups: {
    name: string
    rules: {
      name: string
      type: string
      state?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }[]
  }[]
}

export class Prometheus {
  constructor(private readonly config: Config) {}

  private url(path: string): string {
    return `${this.config.prometheus.url}${path}`
  }

  async health(): Promise<string> {
    await httpText(this.url('/-/ready'), { timeoutMs: 3000 })
    return 'ready'
  }

  /** Re-read the configuration and rule files (needs --web.enable-lifecycle). */
  async reload(): Promise<void> {
    await httpText(this.url('/-/reload'), { method: 'POST', timeoutMs: 10_000 })
  }

  /** Range query; multiple series are summed per timestamp into one series. */
  async queryRange(
    query: string,
    start: number,
    end: number,
    stepSeconds: number
  ): Promise<Point[]> {
    const params = new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(stepSeconds),
    })
    const res = await httpJson<PromResponse<MatrixResult>>(
      this.url(`/api/v1/query_range?${params}`),
      { timeoutMs: 10_000 }
    )
    if (!res || res.status !== 'success')
      throw new Error(res?.error ?? 'prometheus query failed')
    const sums = new Map<number, number>()
    for (const series of res.data.result) {
      for (const [ts, value] of series.values) {
        const v = Number(value)
        if (Number.isFinite(v)) sums.set(ts, (sums.get(ts) ?? 0) + v)
      }
    }
    return [...sums.entries()].sort((a, b) => a[0] - b[0])
  }

  /** Alerting rules for one app/env with their current state (inactive rules included). */
  async alertsFor(app: string, env: string): Promise<AlertView[]> {
    const res = await httpJson<PromResponse<RulesResult>>(
      this.url('/api/v1/rules?type=alert'),
      { timeoutMs: 5000 }
    )
    const views: AlertView[] = []
    for (const group of res?.data.groups ?? []) {
      for (const rule of group.rules) {
        if (rule.labels?.app !== app || rule.labels?.env !== env) continue
        views.push({
          name: rule.name,
          state: (rule.state as AlertView['state']) ?? 'inactive',
          severity: rule.labels?.severity ?? 'warning',
          summary: rule.annotations?.summary,
        })
      }
    }
    return views
  }

  async firingAlerts(): Promise<AlertsResult['alerts']> {
    const res = await httpJson<PromResponse<AlertsResult>>(
      this.url('/api/v1/alerts'),
      { timeoutMs: 5000 }
    )
    return res?.data.alerts ?? []
  }
}
