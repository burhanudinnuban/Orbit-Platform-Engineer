import { useState, type FormEvent } from 'react'
import InlineError from '@/components/atoms/InlineError/InlineError'
import WorkflowCard from '@/components/organisms/WorkflowCard/WorkflowCard'
import { deleteAppApi } from '@/features/apps/apps.api'
import { languageLabel } from '@/features/apps/apps.form'
import type { AppDetail, WorkflowView } from '@/features/apps/apps.types'
import { errorMessage } from '@/services/http'

interface AppSettingsTabProps {
  app: AppDetail
  refresh: () => Promise<void>
}

/** The app's configuration and the type-the-name-to-confirm delete. */
export default function AppSettingsTab({ app, refresh }: AppSettingsTabProps) {
  const [confirm, setConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [started, setStarted] = useState<WorkflowView>()

  const teardown =
    [...app.workflows]
      .filter((w) => w.kind === 'teardown')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? started
  const gone = app.status === 'deleting' || app.status === 'deleted'
  const canDelete = confirm === app.name && !deleting && !gone

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canDelete) return
    setDeleting(true)
    setDeleteError(undefined)
    try {
      const wf = await deleteAppApi(app.name)
      setStarted(wf)
      setConfirm('')
      await refresh()
    } catch (err) {
      setDeleteError(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h3>Configuration</h3>
        <dl className="kv">
          <dt>Template</dt>
          <dd className="mono">{app.template}</dd>
          <dt>Language</dt>
          <dd>{app.language ? languageLabel(app.language) : '—'}</dd>
          <dt>Team</dt>
          <dd>{app.team}</dd>
          <dt>Environments</dt>
          <dd>{app.environments.join(', ')}</dd>
          <dt>Size</dt>
          <dd>{app.options.size}</dd>
          <dt>Database</dt>
          <dd>{app.options.database ? 'Postgres' : 'None'}</dd>
          <dt>S3 bucket</dt>
          <dd>{app.options.objectStorage ? 'Yes' : 'No'}</dd>
          <dt>SQS queue</dt>
          <dd>{app.options.queue ? 'Yes' : 'No'}</dd>
          <dt>Security gate</dt>
          <dd>{app.options.securityGate}</dd>
        </dl>
      </section>

      {teardown ? (
        <WorkflowCard
          app={app.name}
          workflow={teardown}
          defaultOpen
          onChanged={() => void refresh()}
        />
      ) : null}

      <section className="card danger-zone">
        <h3>Delete application</h3>
        <p className="muted">
          Runs the teardown workflow: it removes the GitOps application and its
          deployments, destroys the Terraform resources (namespace, quotas,
          database, S3 bucket and queue), and removes the dashboards, alert
          rules, pipeline webhook and the Git repository. This cannot be undone.
        </p>
        {gone ? (
          <div className="note">
            {app.status === 'deleted'
              ? 'This application has been deleted.'
              : 'Teardown is in progress.'}
          </div>
        ) : (
          <form className="inline-form" onSubmit={submit}>
            <input
              className="input mono"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={app.name}
              aria-label={`Type ${app.name} to confirm`}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!canDelete}
            >
              {deleting ? 'Deleting…' : 'Delete application'}
            </button>
          </form>
        )}
        {!gone ? (
          <div className="muted small">
            Type <span className="mono">{app.name}</span> to confirm.
          </div>
        ) : null}
        <InlineError message={deleteError} />
      </section>
    </div>
  )
}
