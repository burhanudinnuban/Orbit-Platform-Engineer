import type { AppDetail } from '@/features/apps/apps.types'

const PROVIDER_TEXT: Record<string, string> = {
  floci: 'Floci (local AWS)',
  aws: 'AWS',
  none: 'disabled',
}

interface CloudResourcesCardProps {
  app: AppDetail
}

/** The S3 bucket and SQS queue Terraform created for each environment. */
export default function CloudResourcesCard({ app }: CloudResourcesCardProps) {
  return (
    <section className="card">
      <h3>Cloud resources</h3>
      <p className="muted small">
        Created by Terraform (module <span className="mono">app-cloud</span>).
        Each environment's Deployment loads them from Secret{' '}
        <span className="mono">{app.name}-aws</span>:{' '}
        <span className="mono">AWS_REGION</span>,{' '}
        <span className="mono">AWS_ENDPOINT_URL</span> (Floci only),{' '}
        <span className="mono">S3_BUCKET</span> and{' '}
        <span className="mono">SQS_QUEUE_URL</span>.
      </p>
      <dl className="kv">
        {app.environments.map((env) => {
          const c = app.cloud[env]
          return (
            <div key={env} className="kv-group">
              <dt>{env}</dt>
              {c ? (
                <dd>
                  <span className="tag">
                    {PROVIDER_TEXT[c.provider] ?? c.provider}
                  </span>{' '}
                  <span className="muted small">{c.region}</span>
                  {c.bucket ? (
                    <div className="mono small break">s3://{c.bucket}</div>
                  ) : null}
                  {c.queueUrl ? (
                    <div className="mono small break">{c.queueUrl}</div>
                  ) : null}
                  {c.dlqUrl ? (
                    <div className="mono small break muted">DLQ {c.dlqUrl}</div>
                  ) : null}
                </dd>
              ) : (
                <dd className="muted small">
                  {app.status === 'provisioning'
                    ? 'provisioning…'
                    : 'not provisioned'}
                </dd>
              )}
            </div>
          )
        })}
      </dl>
    </section>
  )
}
