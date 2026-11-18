import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import type { DeploymentStatus } from '@/features/deployments/deployments.types'
import { hostOf, relativeTime, shortSha } from '@/lib/format'

interface DeploymentCardProps {
  deployment: DeploymentStatus
}

/** One environment as the GitOps controller sees it, with every resource it applied. */
export default function DeploymentCard({ deployment: d }: DeploymentCardProps) {
  return (
    <section className="card deploy-card">
      <div className="deploy-head">
        <h3>{d.env}</h3>
        <span className="mono muted small">{d.namespace}</span>
        <span className="row push">
          <StatusBadge status={d.syncStatus} />
          <StatusBadge status={d.health} />
        </span>
      </div>
      <dl className="kv">
        <dt>Image</dt>
        <dd className="mono break">
          {d.image || <span className="muted">waiting for first build</span>}
        </dd>
        <dt>Revision</dt>
        <dd className="mono">{shortSha(d.revision)}</dd>
        <dt>Last synced</dt>
        <dd>{relativeTime(d.lastSyncedAt)}</dd>
        <dt>URL</dt>
        <dd>
          {d.url ? (
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="link-external break"
            >
              {hostOf(d.url)}
            </a>
          ) : (
            <span className="muted">—</span>
          )}
        </dd>
      </dl>
      {d.message ? <div className="note">{d.message}</div> : null}
      {d.resources.length > 0 ? (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Name</th>
                <th>Sync</th>
                <th>Health</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {d.resources.map((r) => (
                <tr key={`${r.kind}/${r.namespace ?? ''}/${r.name}`}>
                  <td>{r.kind}</td>
                  <td className="mono">{r.name}</td>
                  <td>
                    <StatusBadge status={r.syncStatus} />
                  </td>
                  <td>
                    <StatusBadge status={r.health} />
                  </td>
                  <td className="muted small">{r.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted small">No resources applied yet.</div>
      )}
    </section>
  )
}
