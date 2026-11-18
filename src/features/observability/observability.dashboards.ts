import { dashboardUid } from '../../config/env.js'
import { promql } from './observability.queries.js'

export const DASHBOARD_FOLDER = { uid: 'orbit-apps', title: 'Orbit Apps' }

const datasource = { type: 'prometheus', uid: 'prometheus' }

interface PanelSpec {
  title: string
  type: 'timeseries' | 'stat'
  unit: string
  targets: { expr: string; legend?: string }[]
  w: number
  h: number
}

/** A Grafana dashboard with the golden signals for one app environment. */
export function buildDashboard(
  app: string,
  env: string,
  namespace: string
): Record<string, unknown> {
  const specs: PanelSpec[] = [
    {
      title: 'Request rate',
      type: 'stat',
      unit: 'reqps',
      targets: [{ expr: promql.requestRate(namespace) }],
      w: 6,
      h: 4,
    },
    {
      title: 'Error rate',
      type: 'stat',
      unit: 'percentunit',
      targets: [{ expr: promql.errorRatio(namespace) }],
      w: 6,
      h: 4,
    },
    {
      title: 'p95 latency',
      type: 'stat',
      unit: 's',
      targets: [{ expr: promql.latencyQuantile(namespace, 0.95) }],
      w: 6,
      h: 4,
    },
    {
      title: 'Targets up',
      type: 'stat',
      unit: 'none',
      targets: [{ expr: promql.targetsUp(namespace) }],
      w: 6,
      h: 4,
    },
    {
      title: 'Requests by status',
      type: 'timeseries',
      unit: 'reqps',
      targets: [
        { expr: promql.requestRateByStatus(namespace), legend: '{{status}}' },
      ],
      w: 12,
      h: 8,
    },
    {
      title: 'Latency',
      type: 'timeseries',
      unit: 's',
      targets: [
        { expr: promql.latencyQuantile(namespace, 0.5), legend: 'p50' },
        { expr: promql.latencyQuantile(namespace, 0.95), legend: 'p95' },
        { expr: promql.latencyQuantile(namespace, 0.99), legend: 'p99' },
      ],
      w: 12,
      h: 8,
    },
    {
      title: 'CPU (cores)',
      type: 'timeseries',
      unit: 'none',
      targets: [{ expr: promql.cpuCores(namespace), legend: 'cpu' }],
      w: 12,
      h: 8,
    },
    {
      title: 'Memory',
      type: 'timeseries',
      unit: 'bytes',
      targets: [{ expr: promql.memoryBytes(namespace), legend: 'working set' }],
      w: 12,
      h: 8,
    },
  ]

  let x = 0
  let y = 0
  let rowHeight = 0
  const panels = specs.map((spec, i) => {
    if (x + spec.w > 24) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    const gridPos = { x, y, w: spec.w, h: spec.h }
    x += spec.w
    rowHeight = Math.max(rowHeight, spec.h)
    return {
      id: i + 1,
      type: spec.type,
      title: spec.title,
      datasource,
      gridPos,
      targets: spec.targets.map((t, j) => ({
        refId: String.fromCharCode(65 + j),
        datasource,
        expr: t.expr,
        legendFormat: t.legend ?? '__auto',
      })),
      fieldConfig: { defaults: { unit: spec.unit }, overrides: [] },
      options:
        spec.type === 'stat'
          ? {
              reduceOptions: {
                calcs: ['lastNotNull'],
                fields: '',
                values: false,
              },
              colorMode: 'value',
              graphMode: 'area',
            }
          : {
              legend: { displayMode: 'list', placement: 'bottom' },
              tooltip: { mode: 'multi' },
            },
    }
  })

  return {
    uid: dashboardUid(app, env),
    title: `${app} · ${env}`,
    tags: ['orbit', `app:${app}`, `env:${env}`],
    timezone: 'browser',
    schemaVersion: 39,
    refresh: '30s',
    time: { from: 'now-1h', to: 'now' },
    panels,
  }
}
