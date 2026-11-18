import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import AppCard from '@/components/organisms/AppCard/AppCard'
import { ROUTES } from '@/constants/routes'
import { fetchAppsApi } from '@/features/apps/apps.api'
import { usePoll } from '@/hooks/usePoll'
import { plural } from '@/lib/format'

/** Every application on the platform, newest activity first, with a client-side filter. */
export default function AppsPage() {
  const { data, error, loading, refresh } = usePoll(() => fetchAppsApi(), [])
  const [query, setQuery] = useState('')

  const apps = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? [])
      .filter((a) => a.status !== 'deleted')
      .filter(
        (a) =>
          !q ||
          a.name.includes(q) ||
          a.team.toLowerCase().includes(q) ||
          a.template.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [data, query])

  const total = (data ?? []).filter((a) => a.status !== 'deleted').length

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Applications</h1>
          <p className="muted">
            {data
              ? plural(total, 'application')
              : 'Everything your teams run on Orbit.'}
          </p>
        </div>
        <div className="page-actions">
          {total > 0 ? (
            <input
              className="input search"
              type="search"
              placeholder="Filter by name, team, template…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter applications"
            />
          ) : null}
          <Link to={ROUTES.NEW_APP} className="btn btn-primary">
            Create application
          </Link>
        </div>
      </header>

      {loading && !data ? (
        <LoadingState label="Loading applications…" />
      ) : !data && error ? (
        <ErrorState error={error} onRetry={() => void refresh()} />
      ) : total === 0 ? (
        <EmptyState
          title="No applications yet"
          action={
            <Link to={ROUTES.NEW_APP} className="btn btn-primary">
              Create application
            </Link>
          }
        >
          Create one and Orbit will set up the repository, pipeline,
          infrastructure, deployment, security scanning and dashboards for you.
        </EmptyState>
      ) : apps.length === 0 ? (
        <EmptyState title="No matches">
          No application matches “{query}”.
        </EmptyState>
      ) : (
        <div className="app-grid">
          {apps.map((app) => (
            <AppCard key={app.name} app={app} />
          ))}
        </div>
      )}
    </div>
  )
}
