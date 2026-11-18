import { useMemo, useState } from 'react'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LineChart from '@/components/molecules/LineChart/LineChart'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import type { AppDetail } from '@/features/apps/apps.types'
import { fetchMetricsApi } from '@/features/observability/observability.api'
import type {
  AlertView,
  MetricsRange,
  Point,
} from '@/features/observability/observability.types'
import { usePoll } from '@/hooks/usePoll'
import { formatNumber } from '@/lib/format'
import type { Tone } from '@/lib/status'

const RANGES: MetricsRange[] = ['15m', '1h', '6h', '24h']

const ALERT_TONE: Record<AlertView['state'], Tone> = {
  firing: 'failed',
  pending: 'warning',
  inactive: 'pending',
}

/** Firing first, then pending, then inactive. */
function alertOrder(state: AlertView['state']): number {
  return state === 'firing' ? 0 : state === 'pending' ? 1 : 2
}

interface AppObservabilityTabProps {
  app: AppDetail
}

export default function AppObservabilityTab({ app }: AppObservabilityTabProps) {
  const [env, setEnv] = useState(app.environments[0] ?? 'dev')
  const [range, setRange] = useState<MetricsRange>('1h')
  const { data, error, loading, refresh } = usePoll(
    () => fetchMetricsApi(app.name, env, range),
    [app.name, env, range],
    15000
  )

  // errorRate is a 0–1 ratio from the API; show it as a percentage.
  const errorPct = useMemo<Point[]>(
    () => (data?.series.errorRate ?? []).map(([t, v]) => [t, v * 100]),
    [data]
  )
  const grafana = app.links.dashboards[env]

  return (
    <div className="stack">
      <div className="toolbar wrap">
        <div className="row">
          {app.environments.length > 1 ? (
            <div
              className="segmented compact"
              role="radiogroup"
              aria-label="Environment"
            >
              {app.environments.map((e) => (
                <label key={e} className={env === e ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="obs-env"
                    checked={env === e}
                    onChange={() => setEnv(e)}
                  />
                  <span className="seg-label">{e}</span>
                </label>
              ))}
            </div>
          ) : (
            <span className="tag">{env}</span>
          )}
          <div
            className="segmented compact"
            role="radiogroup"
            aria-label="Time range"
          >
            {RANGES.map((r) => (
              <label key={r} className={range === r ? 'selected' : ''}>
                <input
                  type="radio"
                  name="obs-range"
                  checked={range === r}
                  onChange={() => setRange(r)}
                />
                <span className="seg-label">{r}</span>
              </label>
            ))}
          </div>
        </div>
        {grafana ? (
          <a
            className="btn btn-sm"
            href={grafana}
            target="_blank"
            rel="noreferrer"
          >
            Open in Grafana ↗
          </a>
        ) : null}
      </div>

      {loading && !data ? (
        <LoadingState label="Querying Prometheus…" />
      ) : !data ? (
        <ErrorState error={error} onRetry={() => void refresh()} />
      ) : !data.available ? (
        <EmptyState title="Metrics not available yet">
          {data.message ??
            'Prometheus has no data for this environment yet. It appears after the first deploy.'}
        </EmptyState>
      ) : (
        <>
          <div className="chart-grid">
            <LineChart
              title="Request rate"
              points={data.series.requestRate}
              format={(v) => `${formatNumber(v)} req/s`}
            />
            <LineChart
              title="Error rate"
              points={errorPct}
              format={(v) => `${formatNumber(v)}%`}
              tone="failed"
            />
            <LineChart
              title="p95 latency"
              points={data.series.p95LatencyMs}
              format={(v) => `${formatNumber(v)} ms`}
              tone="warning"
            />
            <LineChart
              title="CPU"
              points={data.series.cpuCores}
              format={(v) => `${formatNumber(v, 3)} cores`}
              tone="success"
            />
            <LineChart
              title="Memory"
              points={data.series.memoryMb}
              format={(v) => `${formatNumber(v)} MB`}
            />
          </div>

          <section className="card">
            <h3>Alerts</h3>
            {data.alerts.length === 0 ? (
              <div className="muted small">
                No alert rules reported for this environment.
              </div>
            ) : (
              <ul className="alert-list">
                {[...data.alerts]
                  .sort((a, b) => alertOrder(a.state) - alertOrder(b.state))
                  .map((a) => (
                    <li key={a.name}>
                      <StatusBadge
                        status={a.state}
                        tone={ALERT_TONE[a.state]}
                      />
                      <span className="alert-name">{a.name}</span>
                      <span className="tag">{a.severity}</span>
                      {a.summary ? (
                        <span className="muted small">{a.summary}</span>
                      ) : null}
                    </li>
                  ))}
              </ul>
            )}
          </section>
          {error ? (
            <div className="muted small">
              Live updates paused. Showing the last result.
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
