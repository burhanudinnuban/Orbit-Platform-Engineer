interface PendingDeploymentCardProps {
  app: string
  env: string
}

/** An environment the GitOps controller hasn't reported on yet. */
export default function PendingDeploymentCard({
  app,
  env,
}: PendingDeploymentCardProps) {
  return (
    <section className="card deploy-card">
      <div className="deploy-head">
        <h3>{env}</h3>
        <span className="mono muted small">
          {app}-{env}
        </span>
      </div>
      <div className="muted">
        Not deployed yet. The first pipeline run deploys this environment.
      </div>
    </section>
  )
}
