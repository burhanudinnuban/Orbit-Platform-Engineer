import DeploymentCard from '@/components/molecules/DeploymentCard/DeploymentCard'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import PendingDeploymentCard from '@/components/molecules/PendingDeploymentCard/PendingDeploymentCard'
import type { AppDetail } from '@/features/apps/apps.types'
import { fetchDeploymentsApi } from '@/features/deployments/deployments.api'
import { usePoll } from '@/hooks/usePoll'

interface AppDeploymentsTabProps {
  app: AppDetail
}

export default function AppDeploymentsTab({ app }: AppDeploymentsTabProps) {
  const { data, error, loading, refresh } = usePoll(
    () => fetchDeploymentsApi(app.name),
    [app.name]
  )

  if (loading && !data) return <LoadingState label="Loading deployments…" />
  if (!data) return <ErrorState error={error} onRetry={() => void refresh()} />

  // The app's environments first, then any the controller still reports that the app no longer lists.
  const envs = [
    ...app.environments,
    ...data.map((d) => d.env).filter((e) => !app.environments.includes(e)),
  ]
  if (envs.length === 0)
    return (
      <EmptyState title="No environments">
        This application has no environments.
      </EmptyState>
    )

  return (
    <div className="deploy-grid">
      {envs.map((env) => {
        const d = data.find((x) => x.env === env)
        return d ? (
          <DeploymentCard key={env} deployment={d} />
        ) : (
          <PendingDeploymentCard key={env} env={env} app={app.name} />
        )
      })}
    </div>
  )
}
