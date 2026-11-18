/** PromQL used by dashboards, alert rules and the portal metrics API, so they always agree. */
export const promql = {
  requestRate: (ns: string) =>
    `sum(rate(http_requests_total{namespace="${ns}"}[1m]))`,
  requestRateByStatus: (ns: string) =>
    `sum by (status) (rate(http_requests_total{namespace="${ns}"}[1m]))`,
  errorRatio: (ns: string) =>
    `sum(rate(http_requests_total{namespace="${ns}",status=~"5.."}[1m])) / clamp_min(sum(rate(http_requests_total{namespace="${ns}"}[1m])), 1e-9)`,
  latencyQuantile: (ns: string, q: number) =>
    `histogram_quantile(${q}, sum by (le) (rate(http_request_duration_seconds_bucket{namespace="${ns}"}[5m])))`,
  cpuCores: (ns: string) =>
    `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",container!="",container!="POD"}[2m]))`,
  memoryBytes: (ns: string) =>
    `sum(container_memory_working_set_bytes{namespace="${ns}",container!="",container!="POD"})`,
  targetsUp: (ns: string) => `sum(up{namespace="${ns}"})`,
}
