import { Fragment, useState } from 'react'
import InlineError from '@/components/atoms/InlineError/InlineError'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import StatusIcon from '@/components/atoms/StatusIcon/StatusIcon'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import LogView from '@/components/molecules/LogView/LogView'
import {
  cancelPipelineApi,
  fetchPipelineApi,
} from '@/features/pipelines/pipelines.api'
import {
  ACTIVE_STATUSES,
  defaultStage,
} from '@/features/pipelines/pipelines.utils'
import { usePoll } from '@/hooks/usePoll'
import { duration, relativeTime, shortSha } from '@/lib/format'
import { toneFor } from '@/lib/status'
import { errorMessage } from '@/services/http'

interface PipelineRunDetailProps {
  id: string
  onBack: () => void
}

/** One pipeline run: its stage graph and the selected stage's log, refreshed every two seconds. */
export default function PipelineRunDetail({
  id,
  onBack,
}: PipelineRunDetailProps) {
  const { data, error, loading, refresh } = usePoll(
    () => fetchPipelineApi(id),
    [id],
    2000
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string>()

  if (loading && !data) return <LoadingState label="Loading pipeline…" />
  if (!data) {
    return (
      <div className="stack">
        <button type="button" className="btn btn-sm back" onClick={onBack}>
          ← All runs
        </button>
        <ErrorState error={error} onRetry={() => void refresh()} />
      </div>
    )
  }

  const stage = data.stages.find((s) => s.id === selected) ?? defaultStage(data)

  const cancel = async () => {
    setCanceling(true)
    setCancelError(undefined)
    try {
      await cancelPipelineApi(data.id)
      await refresh()
    } catch (err) {
      setCancelError(errorMessage(err))
    } finally {
      setCanceling(false)
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="btn btn-sm back" onClick={onBack}>
          ← All runs
        </button>
        {ACTIVE_STATUSES.has(data.status) ? (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={cancel}
            disabled={canceling}
          >
            {canceling ? 'Canceling…' : 'Cancel'}
          </button>
        ) : null}
      </div>

      <section className="card">
        <div className="pipeline-head">
          <h2>Pipeline #{data.number}</h2>
          <StatusBadge status={data.status} />
          <span className="tag">{data.trigger}</span>
        </div>
        <div className="pipeline-meta">
          <span className="mono">{shortSha(data.commitSha)}</span>
          {data.commitMessage ? (
            <span className="truncate">{data.commitMessage}</span>
          ) : null}
          <span className="muted">
            on <span className="mono">{data.branch}</span>
          </span>
          <span className="muted">
            started {relativeTime(data.startedAt ?? data.createdAt)}
          </span>
          <span className="muted">
            took{' '}
            {data.startedAt ? duration(data.startedAt, data.finishedAt) : '—'}
          </span>
        </div>
        <InlineError message={cancelError} />
        {error ? (
          <div className="muted small">
            Live updates paused: {errorMessage(error)}
          </div>
        ) : null}
      </section>

      {data.stages.length === 0 ? (
        <EmptyState title="No stages">
          This pipeline has no stages yet.
        </EmptyState>
      ) : (
        <>
          <div className="stage-graph" role="list">
            {data.stages.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 ? (
                  <span
                    className={`stage-edge tone-${toneFor(s.status)}`}
                    aria-hidden="true"
                  />
                ) : null}
                <button
                  type="button"
                  role="listitem"
                  className={`stage tone-${toneFor(s.status)} ${stage?.id === s.id ? 'active' : ''}`}
                  onClick={() => setSelected(s.id)}
                >
                  <StatusIcon status={s.status} />
                  <span className="stage-text">
                    <span className="stage-name">{s.name}</span>
                    <span className="stage-type">
                      {s.type} ·{' '}
                      {s.startedAt
                        ? duration(s.startedAt, s.finishedAt)
                        : s.status}
                    </span>
                  </span>
                </button>
              </Fragment>
            ))}
          </div>

          {stage ? (
            <section className="card">
              <div className="stage-panel-head">
                <h3>
                  {stage.name}{' '}
                  <span className="muted small">({stage.type})</span>
                </h3>
                <StatusBadge status={stage.status} />
              </div>
              {stage.error ? (
                <div className="inline-error">{stage.error}</div>
              ) : null}
              <LogView
                text={stage.logs}
                maxHeight={480}
                emptyText={
                  stage.status === 'pending'
                    ? 'Waiting for earlier stages.'
                    : 'No output.'
                }
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
