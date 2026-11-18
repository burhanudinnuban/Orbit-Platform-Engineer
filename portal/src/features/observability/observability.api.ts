import apiClient from '@/services/http'
import type { MetricsRange, MetricsResponse } from './observability.types'

const seg = encodeURIComponent

const endpoints = {
  metrics: (app: string, env: string, range: MetricsRange) =>
    `/api/apps/${seg(app)}/metrics?env=${seg(env)}&range=${seg(range)}`,
}

/** Request rate, errors, latency, CPU and memory from Prometheus, plus alert state. */
export function fetchMetricsApi(
  app: string,
  env: string,
  range: MetricsRange
): Promise<MetricsResponse> {
  return apiClient.get<MetricsResponse>(endpoints.metrics(app, env, range))
}
