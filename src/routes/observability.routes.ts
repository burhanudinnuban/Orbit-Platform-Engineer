import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../app/server.js'
import { appNamespace } from '../config/env.js'
import { promql } from '../features/observability/observability.queries.js'
import { HttpProblem } from '../lib/httpProblem.js'
import { errorMessage } from '../lib/logger.js'
import type { MetricsResponse, Point } from '../types/contract.js'
import { requireApp } from './routes.helpers.js'

/** Time ranges the portal offers, with a Prometheus step that keeps each to a few hundred points. */
const RANGES: Record<string, { seconds: number; step: number }> = {
  '15m': { seconds: 15 * 60, step: 15 },
  '1h': { seconds: 3600, step: 30 },
  '6h': { seconds: 6 * 3600, step: 120 },
  '24h': { seconds: 24 * 3600, step: 300 },
}

/** Golden-signal metrics and alert state for one app environment. */
export function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: ServerDeps
): void {
  const { platform } = deps

  app.get<{
    Params: { name: string }
    Querystring: { env?: string; range?: string }
  }>('/api/apps/:name/metrics', async (req): Promise<MetricsResponse> => {
    const record = requireApp(platform.store, req.params.name)
    const env = req.query.env ?? record.environments[0]!
    if (!record.environments.includes(env))
      throw new HttpProblem(400, `unknown environment ${env}`)
    const range = RANGES[req.query.range ?? '1h'] ?? RANGES['1h']!
    const ns = appNamespace(record.name, env)
    const end = Math.floor(Date.now() / 1000)
    const start = end - range.seconds
    const empty: MetricsResponse['series'] = {
      requestRate: [],
      errorRate: [],
      p95LatencyMs: [],
      cpuCores: [],
      memoryMb: [],
    }
    try {
      const q = (expr: string) =>
        platform.prometheus.queryRange(expr, start, end, range.step)
      const scale = (points: Point[], factor: number): Point[] =>
        points.map(([t, v]) => [t, v * factor])
      const [requestRate, errorRate, p95, cpu, memory, alerts] =
        await Promise.all([
          q(promql.requestRate(ns)),
          q(promql.errorRatio(ns)),
          q(promql.latencyQuantile(ns, 0.95)),
          q(promql.cpuCores(ns)),
          q(promql.memoryBytes(ns)),
          platform.prometheus.alertsFor(record.name, env).catch(() => []),
        ])
      return {
        env,
        available: true,
        series: {
          requestRate,
          errorRate,
          p95LatencyMs: scale(p95, 1000),
          cpuCores: cpu,
          memoryMb: scale(memory, 1 / (1024 * 1024)),
        },
        alerts,
      }
    } catch (err) {
      return {
        env,
        available: false,
        message: `Prometheus unavailable: ${errorMessage(err)}`,
        series: empty,
        alerts: [],
      }
    }
  })
}
