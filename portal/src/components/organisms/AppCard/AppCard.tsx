import type { KeyboardEvent, MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AppAvatar from '@/components/atoms/AppAvatar/AppAvatar'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import SeverityBar from '@/components/molecules/SeverityBar/SeverityBar'
import { appPath } from '@/constants/routes'
import { languageLabel } from '@/features/apps/apps.form'
import type { AppSummary } from '@/features/apps/apps.types'
import { hostOf, relativeTime, shortSha } from '@/lib/format'
import { toneFor } from '@/lib/status'

interface AppCardProps {
  app: AppSummary
}

/**
 * An application on the overview grid: status, latest pipeline, per-environment
 * health and findings. The whole card opens the app; links and buttons inside it
 * keep their own behaviour.
 */
export default function AppCard({ app }: AppCardProps) {
  const navigate = useNavigate()
  const href = appPath(app.name)
  const firstUrl = app.environments
    .map((e) => app.links.urls[e])
    .find((u): u is string => Boolean(u))
  const pipeline = app.latestPipeline

  const open = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button')) return
    navigate(href)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) navigate(href)
  }

  return (
    <article
      className="card app-card"
      onClick={open}
      onKeyDown={onKey}
      tabIndex={0}
      aria-label={app.name}
    >
      <div className="app-card-head">
        <AppAvatar name={app.name} />
        <div className="app-card-title">
          <Link to={href} className="app-name">
            {app.name}
          </Link>
          <div className="muted small truncate">
            {app.team} · {app.template}
            {app.language ? ` (${languageLabel(app.language)})` : ''}
          </div>
        </div>
        <StatusBadge status={app.status} />
      </div>

      {app.description ? <p className="app-desc">{app.description}</p> : null}

      <dl className="app-facts">
        <div>
          <dt>Pipeline</dt>
          <dd>
            {pipeline ? (
              <>
                <StatusBadge status={pipeline.status} />
                <span className="mono small">
                  #{pipeline.number} {shortSha(pipeline.commitSha)}
                </span>
                <span className="muted small">
                  {relativeTime(pipeline.createdAt)}
                </span>
              </>
            ) : (
              <span className="muted small">No runs yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Deploy</dt>
          <dd className="env-chips">
            {app.environments.map((env) => {
              const d = app.deployments.find((x) => x.env === env)
              const health = d?.health ?? 'Unknown'
              return (
                <span
                  key={env}
                  className={`env-chip tone-${toneFor(health)}`}
                  title={
                    d
                      ? `${env}: ${health} · ${d.syncStatus}`
                      : `${env}: not deployed yet`
                  }
                >
                  <span className="dot" aria-hidden="true" />
                  {env}
                </span>
              )
            })}
          </dd>
        </div>
        <div>
          <dt>Security</dt>
          <dd>
            <SeverityBar counts={app.findings} />
          </dd>
        </div>
      </dl>

      <footer className="app-card-foot">
        {firstUrl ? (
          <a
            href={firstUrl}
            target="_blank"
            rel="noreferrer"
            className="link-external truncate"
          >
            {hostOf(firstUrl)}
          </a>
        ) : (
          <span className="muted small">No URL yet</span>
        )}
        <span className="muted small">
          updated {relativeTime(app.updatedAt)}
        </span>
      </footer>
    </article>
  )
}
