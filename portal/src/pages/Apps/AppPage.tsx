import { Link, useParams, useSearchParams } from 'react-router-dom'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import AppDeploymentsTab from '@/components/organisms/AppDeploymentsTab/AppDeploymentsTab'
import AppHeader from '@/components/organisms/AppHeader/AppHeader'
import AppObservabilityTab from '@/components/organisms/AppObservabilityTab/AppObservabilityTab'
import AppOverviewTab from '@/components/organisms/AppOverviewTab/AppOverviewTab'
import AppPipelinesTab from '@/components/organisms/AppPipelinesTab/AppPipelinesTab'
import AppSecurityTab from '@/components/organisms/AppSecurityTab/AppSecurityTab'
import AppSettingsTab from '@/components/organisms/AppSettingsTab/AppSettingsTab'
import { ROUTES } from '@/constants/routes'
import { fetchAppApi } from '@/features/apps/apps.api'
import { usePoll } from '@/hooks/usePoll'
import { errorMessage, isNotFound } from '@/services/http'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'security', label: 'Security' },
  { id: 'observability', label: 'Observability' },
  { id: 'settings', label: 'Settings' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * One application. The open tab lives in `?tab=`, so a tab can be linked to
 * and survives a reload; Overview is the default and keeps the URL clean.
 */
export default function AppPage() {
  const { name = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab: TabId =
    TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview'
  const {
    data: app,
    error,
    loading,
    refresh,
  } = usePoll(() => fetchAppApi(name), [name])

  const selectTab = (id: TabId) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id === 'overview') next.delete('tab')
      else next.set('tab', id)
      next.delete('run')
      return next
    })

  if (loading && !app) {
    return (
      <div className="page">
        <LoadingState label={`Loading ${name}…`} />
      </div>
    )
  }

  if (!app) {
    return (
      <div className="page">
        <Link to={ROUTES.HOME} className="crumb">
          ← Applications
        </Link>
        {isNotFound(error) ? (
          <EmptyState
            title="Application not found"
            action={
              <Link className="btn" to={ROUTES.HOME}>
                Back to applications
              </Link>
            }
          >
            There is no application named <span className="mono">{name}</span>.
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refresh()} />
        )}
      </div>
    )
  }

  const highPlus = app.findings.critical + app.findings.high
  const running =
    app.latestPipeline &&
    (app.latestPipeline.status === 'running' ||
      app.latestPipeline.status === 'queued')

  return (
    <div className="page">
      <Link to={ROUTES.HOME} className="crumb">
        ← Applications
      </Link>
      <AppHeader app={app} />

      {error ? (
        <div className="banner banner-warn" role="status">
          Showing the last known state. {errorMessage(error)}
        </div>
      ) : null}

      <nav className="tabs" role="tablist" aria-label="Application sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
            {t.id === 'security' && highPlus > 0 ? (
              <span className="tab-count sev-high">{highPlus}</span>
            ) : null}
            {t.id === 'pipelines' && running ? (
              <span className="tab-dot" aria-label="running" />
            ) : null}
          </button>
        ))}
      </nav>

      <div className="tab-panel" role="tabpanel">
        {tab === 'overview' ? (
          <AppOverviewTab app={app} refresh={refresh} />
        ) : null}
        {tab === 'pipelines' ? <AppPipelinesTab app={app} /> : null}
        {tab === 'deployments' ? <AppDeploymentsTab app={app} /> : null}
        {tab === 'security' ? <AppSecurityTab app={app} /> : null}
        {tab === 'observability' ? <AppObservabilityTab app={app} /> : null}
        {tab === 'settings' ? (
          <AppSettingsTab app={app} refresh={refresh} />
        ) : null}
      </div>
    </div>
  )
}
