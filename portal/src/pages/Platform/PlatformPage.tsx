import StatusIcon from '@/components/atoms/StatusIcon/StatusIcon'
import { Link } from 'react-router-dom'
import ApiTokenCard from '@/components/molecules/ApiTokenCard/ApiTokenCard'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import { ROUTES } from '@/constants/routes'
import { languageLabel } from '@/features/apps/apps.form'
import { fetchPlatformApi } from '@/features/platform/platform.api'
import { usePoll } from '@/hooks/usePoll'

/** Health of the engines behind the golden path, and links to the tools Orbit reuses. */
export default function PlatformPage() {
  const { data, error, loading, refresh } = usePoll(
    () => fetchPlatformApi(),
    [],
    10000
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Platform</h1>
          <p className="muted">Health of the engines behind the golden path.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {loading && !data ? (
        <LoadingState label="Checking platform components…" />
      ) : !data ? (
        <ErrorState error={error} onRetry={() => void refresh()} />
      ) : (
        <div className="platform-grid">
          <section className="card">
            <h2>Components</h2>
            <ul className="component-list">
              {data.components.map((c) => (
                <li key={c.name}>
                  <StatusIcon status={c.ok ? 'succeeded' : 'failed'} />
                  <span className="component-name">{c.name}</span>
                  <span className={`small ${c.ok ? 'muted' : 'text-failed'}`}>
                    {c.message ?? (c.ok ? 'OK' : 'Unavailable')}
                  </span>
                </li>
              ))}
              {data.components.length === 0 ? (
                <li className="muted">No components reported.</li>
              ) : null}
            </ul>
          </section>

          <section className="card">
            <h2>Cluster</h2>
            <dl className="kv">
              <dt>Version</dt>
              <dd className="mono">{data.version}</dd>
              <dt>Kube context</dt>
              <dd className="mono">{data.kubeContext}</dd>
              <dt>Runtime</dt>
              <dd>
                {data.runtime === 'compose' ? 'Docker Compose' : 'kind'} ·{' '}
                <Link to={ROUTES.VERSIONS}>component versions</Link>
              </dd>
              <dt>Environments</dt>
              <dd>
                {data.environments.map((e) => (
                  <span key={e} className="tag">
                    {e}
                  </span>
                ))}
              </dd>
            </dl>
          </section>

          <section className="card">
            <h2>Tools</h2>
            <ul className="link-list">
              <li>
                <a
                  href={data.links.git}
                  target="_blank"
                  rel="noreferrer"
                  className="link-external"
                >
                  Gitea
                </a>
                <span className="muted small mono">{data.links.git}</span>
              </li>
              <li>
                <a
                  href={data.links.grafana}
                  target="_blank"
                  rel="noreferrer"
                  className="link-external"
                >
                  Grafana
                </a>
                <span className="muted small mono">{data.links.grafana}</span>
              </li>
              <li>
                <a
                  href={data.links.prometheus}
                  target="_blank"
                  rel="noreferrer"
                  className="link-external"
                >
                  Prometheus
                </a>
                <span className="muted small mono">
                  {data.links.prometheus}
                </span>
              </li>
              <li>
                {data.links.cloud ? (
                  <>
                    <span>Floci (local AWS)</span>
                    <span className="muted small mono">
                      aws --endpoint-url {data.links.cloud} s3 ls
                    </span>
                  </>
                ) : (
                  <>
                    <span>Cloud</span>
                    <span className="muted small mono">
                      {data.cloud.provider === 'aws'
                        ? `AWS ${data.cloud.region}`
                        : 'disabled'}
                    </span>
                  </>
                )}
              </li>
            </ul>
          </section>

          <section className="card">
            <h2>Templates</h2>
            <ul className="template-list">
              {data.templates.map((t) => (
                <li key={t.id}>
                  <strong>{t.name}</strong>{' '}
                  {t.languages.map((l) => (
                    <span key={l} className="tag">
                      {languageLabel(l)}
                    </span>
                  ))}
                  <div className="muted small">{t.description}</div>
                </li>
              ))}
              {data.templates.length === 0 ? (
                <li className="muted">No templates registered.</li>
              ) : null}
            </ul>
          </section>

          <ApiTokenCard />
        </div>
      )}
    </div>
  )
}
