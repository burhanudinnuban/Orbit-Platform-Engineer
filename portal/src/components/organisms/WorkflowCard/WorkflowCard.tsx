import { useState } from 'react'
import InlineError from '@/components/atoms/InlineError/InlineError'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import WorkflowStepRow from '@/components/molecules/WorkflowStepRow/WorkflowStepRow'
import { retryWorkflowApi } from '@/features/apps/apps.api'
import type { WorkflowView } from '@/features/apps/apps.types'
import { duration, relativeTime } from '@/lib/format'
import { toneFor } from '@/lib/status'
import { errorMessage } from '@/services/http'

const FINAL = new Set(['succeeded', 'failed'])

interface WorkflowCardProps {
  app: string
  workflow: WorkflowView
  defaultOpen: boolean
  onChanged?: () => void
}

/** A provisioning or teardown workflow: progress, a retry for failures, and its step timeline. */
export default function WorkflowCard({
  app,
  workflow,
  defaultOpen,
  onChanged,
}: WorkflowCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string>()

  const steps = workflow.steps
  const done = steps.filter(
    (s) => s.status === 'succeeded' || s.status === 'skipped'
  ).length
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
  const title = workflow.kind === 'provision' ? 'Provisioning' : 'Teardown'

  const retry = async () => {
    setRetrying(true)
    setRetryError(undefined)
    try {
      await retryWorkflowApi(app, workflow.id)
      setOpen(true)
      onChanged?.()
    } catch (err) {
      setRetryError(errorMessage(err))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <section className={`card workflow tone-${toneFor(workflow.status)}`}>
      <div className="workflow-head">
        <button
          type="button"
          className="workflow-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span
            className={`chevron ${open ? 'open' : ''}`}
            aria-hidden="true"
          />
          <span className="workflow-title">{title}</span>
          <StatusBadge status={workflow.status} />
          <span className="muted small">
            {done}/{steps.length} steps · started{' '}
            {relativeTime(workflow.createdAt)} ·{' '}
            {duration(
              workflow.createdAt,
              FINAL.has(workflow.status) ? workflow.updatedAt : undefined
            )}
          </span>
        </button>
        {workflow.status === 'failed' ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={retry}
            disabled={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
      </div>
      <div className="progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <InlineError message={retryError} />
      {workflow.error ? (
        <div className="inline-error">{workflow.error}</div>
      ) : null}
      {open ? (
        <ol className="timeline">
          {steps.map((step) => (
            <WorkflowStepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : null}
    </section>
  )
}
