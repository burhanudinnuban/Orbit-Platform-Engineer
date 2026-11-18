import { useMemo, useState } from 'react'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import FindingRow from '@/components/molecules/FindingRow/FindingRow'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import type { AppDetail } from '@/features/apps/apps.types'
import { fetchFindingsApi } from '@/features/security/security.api'
import {
  CATEGORIES,
  emptyCounts,
  GATE_RANK,
  SEVERITIES,
  SEVERITY_RANK,
  TOOLS,
} from '@/features/security/security.severity'
import type {
  FindingCategory,
  ScanTool,
  Severity,
} from '@/features/security/security.types'
import { usePoll } from '@/hooks/usePoll'

interface AppSecurityTabProps {
  app: AppDetail
}

/** Findings by severity, what the security gate would block, and a filterable table. */
export default function AppSecurityTab({ app }: AppSecurityTabProps) {
  const { data, error, loading, refresh } = usePoll(
    () => fetchFindingsApi(app.name),
    [app.name],
    10000
  )
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [category, setCategory] = useState<FindingCategory | 'all'>('all')
  const [tool, setTool] = useState<ScanTool | 'all'>('all')
  const [query, setQuery] = useState('')

  const counts = useMemo(() => {
    const c = emptyCounts()
    for (const f of data ?? []) c[f.severity] = (c[f.severity] ?? 0) + 1
    return c
  }, [data])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? [])
      .filter((f) => severity === 'all' || f.severity === severity)
      .filter((f) => category === 'all' || f.category === category)
      .filter((f) => tool === 'all' || f.tool === tool)
      .filter(
        (f) =>
          !q ||
          f.title.toLowerCase().includes(q) ||
          f.ruleId.toLowerCase().includes(q) ||
          (f.location ?? '').toLowerCase().includes(q)
      )
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          a.title.localeCompare(b.title)
      )
  }, [data, severity, category, tool, query])

  const gate = app.options.securityGate
  const gateRank = GATE_RANK[gate]
  const blocking =
    gateRank === undefined
      ? 0
      : (data ?? []).filter((f) => SEVERITY_RANK[f.severity] <= gateRank).length

  if (loading && !data) return <LoadingState label="Loading findings…" />
  if (!data) return <ErrorState error={error} onRetry={() => void refresh()} />

  return (
    <div className="stack">
      <div className="sev-tiles">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            className={`sev-tile sev-tile-${s} ${severity === s ? 'active' : ''}`}
            onClick={() => setSeverity(severity === s ? 'all' : s)}
            aria-pressed={severity === s}
          >
            <span className="sev-tile-count">{counts[s]}</span>
            <span className="sev-tile-label">{s}</span>
          </button>
        ))}
      </div>

      <div className={`note ${blocking > 0 ? 'note-failed' : ''}`}>
        Security gate: <strong>{gate}</strong>.{' '}
        {gate === 'off'
          ? 'Findings are reported but never block a pipeline.'
          : blocking > 0
            ? `${blocking} finding${blocking === 1 ? '' : 's'} at or above the gate will block deploys until fixed.`
            : 'No findings at or above the gate.'}
      </div>

      <div className="filters">
        <input
          type="search"
          className="input search"
          placeholder="Search title, rule, location…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search findings"
        />
        <select
          className="input"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity | 'all')}
          aria-label="Severity"
        >
          <option value="all">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as FindingCategory | 'all')
          }
          aria-label="Category"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={tool}
          onChange={(e) => setTool(e.target.value as ScanTool | 'all')}
          aria-label="Tool"
        >
          <option value="all">All tools</option>
          {TOOLS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {data.length === 0 ? (
        <EmptyState title="No findings">
          Nothing reported yet. Findings appear after a pipeline runs its{' '}
          <span className="mono">scan</span> and{' '}
          <span className="mono">dast</span> stages.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="No matches">
          No finding matches the current filters.
        </EmptyState>
      ) : (
        <div className="table-wrap card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Source</th>
                <th>Title</th>
                <th>Location</th>
                <th>Rule</th>
                <th>Found</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <FindingRow key={f.id} finding={f} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted small">
        Showing {rows.length} of {data.length}
      </div>
    </div>
  )
}
