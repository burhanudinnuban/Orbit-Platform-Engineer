import { useState } from 'react'
import { Link } from 'react-router-dom'
import InlineError from '@/components/atoms/InlineError/InlineError'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import ComponentVersionsCard from '@/components/organisms/ComponentVersionsCard/ComponentVersionsCard'
import PlatformUpdatesCard from '@/components/organisms/PlatformUpdatesCard/PlatformUpdatesCard'
import { ROUTES } from '@/constants/routes'
import { fetchSessionApi } from '@/features/auth/auth.api'
import {
  checkVersionsApi,
  fetchVersionsApi,
  rollbackComponentApi,
  updateAllApi,
  updateComponentApi,
} from '@/features/versions/versions.api'
import type { VersionGroup } from '@/features/versions/versions.types'
import { usePoll } from '@/hooks/usePoll'
import { relativeTime } from '@/lib/format'
import { errorMessage } from '@/services/http'

const GROUPS: { id: VersionGroup; title: string; hint: string }[] = [
  {
    id: 'runtime',
    title: 'Runtime',
    hint: 'The cluster, its network and the registry. Updating Kubernetes restarts the cluster.',
  },
  {
    id: 'service',
    title: 'Platform services',
    hint: 'Tools the platform runs for every app. Each update is health-checked.',
  },
  {
    id: 'ci',
    title: 'CI and Terraform tools',
    hint: 'Images of pipeline and Terraform jobs. A new version is downloaded and tested before jobs use it.',
  },
]

/**
 * Platform → Versions: what every component runs, what is newer, and (for
 * admins) updating one, all, or rolling back.
 */
export default function VersionsPage() {
  const versions = usePoll(() => fetchVersionsApi(), [], 5000)
  const session = usePoll(() => fetchSessionApi(), [], 0)
  const [busyId, setBusyId] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [checking, setChecking] = useState(false)

  const data = versions.data
  const isAdmin = session.data?.role === 'admin'
  const updatable =
    data?.components.filter(
      (c) => c.recommended && c.manageable && !c.activeUpdate
    ) ?? []

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setActionError(undefined)
    try {
      await fn()
      await versions.refresh()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const check = async () => {
    setChecking(true)
    setActionError(undefined)
    try {
      await checkVersionsApi()
      await versions.refresh()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setChecking(false)
    }
  }

  const updateAll = () => {
    const names = updatable.map((c) => `${c.name} → ${c.recommended}`)
    if (
      !window.confirm(
        `Update ${names.length} component(s), one at a time?\n\n${names.join('\n')}\n\nMajor versions are left out; pick those one by one.`
      )
    )
      return
    void act('*', () => updateAllApi())
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Versions</h1>
          <p className="muted">
            Every component of the platform, and the newer releases in its
            registry.
            {data?.checkedAt
              ? ` Checked ${relativeTime(data.checkedAt)}.`
              : data?.checking
                ? ' Checking the registries…'
                : ''}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={checking || data?.checking}
            onClick={() => void check()}
          >
            {checking || data?.checking ? 'Checking…' : 'Check for updates'}
          </button>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={updatable.length === 0 || busyId !== undefined}
              onClick={updateAll}
            >
              Update all{updatable.length ? ` (${updatable.length})` : ''}
            </button>
          ) : null}
        </div>
      </header>

      {session.data && !isAdmin ? (
        <div className="banner banner-warn">
          {session.data.adminConfigured ? (
            <>
              Only platform admins can update. Save the admin token (
              <span className="mono">ORBIT_ADMIN_TOKEN</span> in{' '}
              <span className="mono">.env</span>) on the{' '}
              <Link to={ROUTES.PLATFORM}>Platform</Link> page.
            </>
          ) : (
            <>
              No admin is configured. Run{' '}
              <span className="mono">npm run bootstrap</span> (it generates{' '}
              <span className="mono">ORBIT_ADMIN_TOKEN</span> in{' '}
              <span className="mono">.env</span>), restart Orbit, then save the
              token on the <Link to={ROUTES.PLATFORM}>Platform</Link> page.
            </>
          )}
        </div>
      ) : null}
      <InlineError message={actionError} />

      {versions.loading && !data ? (
        <LoadingState label="Reading platform versions…" />
      ) : !data ? (
        <ErrorState
          error={versions.error}
          onRetry={() => void versions.refresh()}
        />
      ) : (
        <div className="versions-layout">
          {GROUPS.map((g) => (
            <ComponentVersionsCard
              key={g.id}
              title={g.title}
              hint={g.hint}
              components={data.components.filter((c) => c.group === g.id)}
              isAdmin={isAdmin}
              busyId={busyId === '*' ? undefined : busyId}
              onUpdate={(id, version) =>
                void act(id, () => updateComponentApi(id, version))
              }
              onRollback={(id) => {
                const c = data.components.find((x) => x.id === id)
                if (
                  window.confirm(
                    `Roll ${c?.name ?? id} back to ${c?.previousImage ?? 'its previous version'}?`
                  )
                )
                  void act(id, () => rollbackComponentApi(id))
              }}
            />
          ))}
          <PlatformUpdatesCard updates={data.updates} />
        </div>
      )}
    </div>
  )
}
