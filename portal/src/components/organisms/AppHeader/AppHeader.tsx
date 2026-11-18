import AppAvatar from '@/components/atoms/AppAvatar/AppAvatar'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import { languageLabel } from '@/features/apps/apps.form'
import type { AppDetail } from '@/features/apps/apps.types'
import { relativeTime } from '@/lib/format'

interface AppHeaderProps {
  app: AppDetail
}

/** Name, status and owner of an app, with links out to its repo, URLs and dashboards. */
export default function AppHeader({ app }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-main">
        <AppAvatar name={app.name} size={44} />
        <div className="app-header-text">
          <div className="app-header-title">
            <h1>{app.name}</h1>
            <StatusBadge status={app.status} />
          </div>
          <div className="muted small">
            {app.team} · {app.template}
            {app.language ? ` (${languageLabel(app.language)})` : ''} · created{' '}
            {relativeTime(app.createdAt)}
          </div>
          {app.description ? (
            <p className="app-header-desc">{app.description}</p>
          ) : null}
        </div>
      </div>
      <div className="app-links">
        {app.links.repository ? (
          <a
            className="btn btn-sm"
            href={app.links.repository}
            target="_blank"
            rel="noreferrer"
          >
            Repository ↗
          </a>
        ) : null}
        {app.environments.map((env) =>
          app.links.urls[env] ? (
            <a
              key={`url-${env}`}
              className="btn btn-sm"
              href={app.links.urls[env]}
              target="_blank"
              rel="noreferrer"
            >
              Visit {env} ↗
            </a>
          ) : null
        )}
        {app.environments.map((env) =>
          app.links.dashboards[env] ? (
            <a
              key={`dash-${env}`}
              className="btn btn-sm"
              href={app.links.dashboards[env]}
              target="_blank"
              rel="noreferrer"
            >
              Grafana {env} ↗
            </a>
          ) : null
        )}
      </div>
    </header>
  )
}
