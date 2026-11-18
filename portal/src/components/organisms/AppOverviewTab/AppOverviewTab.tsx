import { Link } from 'react-router-dom'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import CloudResourcesCard from '@/components/molecules/CloudResourcesCard/CloudResourcesCard'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import SeverityBar from '@/components/molecules/SeverityBar/SeverityBar'
import WorkflowCard from '@/components/organisms/WorkflowCard/WorkflowCard'
import type { AppDetail } from '@/features/apps/apps.types'
import { GATE_TEXT } from '@/features/security/security.severity'
import { relativeTime, shortSha } from '@/lib/format'

interface AppOverviewTabProps {
  app: AppDetail
  refresh: () => Promise<void>
}

function cloudSummary(app: AppDetail): string {
  const parts = [
    app.options.objectStorage && 'S3',
    app.options.queue && 'SQS',
  ].filter(Boolean)
  return parts.length ? parts.join(' + ') : 'None'
}

export default function AppOverviewTab({ app, refresh }: AppOverviewTabProps) {
  const workflows = [...app.workflows].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )
  const pipeline = app.latestPipeline

  return (
    <div className="stack">
      <div className="summary-grid">
        <section className="card summary">
          <h3>Latest pipeline</h3>
          {pipeline ? (
            <Link
              to={`?tab=pipelines&run=${encodeURIComponent(pipeline.id)}`}
              className="summary-link"
            >
              <div className="row">
                <StatusBadge status={pipeline.status} />
                <span className="mono">#{pipeline.number}</span>
                <span className="mono muted">
                  {shortSha(pipeline.commitSha)}
                </span>
              </div>
              <div className="small truncate">
                {pipeline.commitMessage ?? pipeline.branch}
              </div>
              <div className="muted small">
                {pipeline.trigger} · {relativeTime(pipeline.createdAt)}
              </div>
            </Link>
          ) : (
            <div className="muted small">
              No runs yet. The first run starts at the end of provisioning.
            </div>
          )}
        </section>

        <section className="card summary">
          <h3>Deployments</h3>
          <ul className="mini-list">
            {app.environments.map((env) => {
              const d = app.deployments.find((x) => x.env === env)
              return (
                <li key={env}>
                  <span className="mono">{env}</span>
                  {d ? (
                    <span className="row">
                      <StatusBadge status={d.health} />
                      <StatusBadge status={d.syncStatus} />
                    </span>
                  ) : (
                    <span className="muted small">not deployed</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <section className="card summary">
          <h3>Security</h3>
          <SeverityBar counts={app.findings} legend />
          <div className="muted small">
            Gate:{' '}
            {GATE_TEXT[app.options.securityGate] ?? app.options.securityGate}
          </div>
        </section>

        <section className="card summary">
          <h3>Configuration</h3>
          <dl className="kv compact">
            <dt>Size</dt>
            <dd>{app.options.size}</dd>
            <dt>Database</dt>
            <dd>{app.options.database ? 'Postgres' : 'None'}</dd>
            <dt>Cloud</dt>
            <dd>{cloudSummary(app)}</dd>
            <dt>Envs</dt>
            <dd>{app.environments.join(', ')}</dd>
          </dl>
        </section>
      </div>

      {app.options.objectStorage || app.options.queue ? (
        <CloudResourcesCard app={app} />
      ) : null}

      <section className="stack">
        <h2 className="section-title">Workflows</h2>
        {workflows.length === 0 ? (
          <EmptyState title="No workflows yet">
            Provisioning starts right after the application is created.
          </EmptyState>
        ) : (
          workflows.map((wf, i) => (
            <WorkflowCard
              key={wf.id}
              app={app.name}
              workflow={wf}
              defaultOpen={i === 0}
              onChanged={() => void refresh()}
            />
          ))
        )}
      </section>
    </div>
  )
}
