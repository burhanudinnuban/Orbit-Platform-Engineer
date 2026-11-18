import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import InlineError from '@/components/atoms/InlineError/InlineError'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import EmptyState from '@/components/molecules/EmptyState/EmptyState'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import PipelineRunDetail from '@/components/organisms/PipelineRunDetail/PipelineRunDetail'
import type { AppDetail } from '@/features/apps/apps.types'
import {
  fetchPipelinesApi,
  runPipelineApi,
} from '@/features/pipelines/pipelines.api'
import { usePoll } from '@/hooks/usePoll'
import { duration, relativeTime, shortSha } from '@/lib/format'
import { errorMessage } from '@/services/http'

interface AppPipelinesTabProps {
  app: AppDetail
}

/** The run list, or one run when `?run=<id>` is in the URL. */
export default function AppPipelinesTab({ app }: AppPipelinesTabProps) {
  const [params, setParams] = useSearchParams()
  const runId = params.get('run')
  const list = usePoll(() => fetchPipelinesApi(app.name), [app.name])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string>()

  const select = (id: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', 'pipelines')
      if (id) next.set('run', id)
      else next.delete('run')
      return next
    })

  const runNow = async () => {
    setStarting(true)
    setStartError(undefined)
    try {
      const p = await runPipelineApi(app.name)
      void list.refresh()
      select(p.id)
    } catch (err) {
      setStartError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  if (runId) return <PipelineRunDetail id={runId} onBack={() => select(null)} />

  const canRun = app.status !== 'deleting' && app.status !== 'deleted'
  const runs = [...(list.data ?? [])].sort((a, b) => b.number - a.number)

  return (
    <div className="stack">
      <div className="toolbar">
        <h2 className="section-title">Pipelines</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={runNow}
          disabled={!canRun || starting}
        >
          {starting ? 'Starting…' : 'Run pipeline'}
        </button>
      </div>
      <InlineError message={startError} />

      {list.loading && !list.data ? (
        <LoadingState label="Loading pipelines…" />
      ) : !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refresh()} />
      ) : runs.length === 0 ? (
        <EmptyState title="No pipeline runs yet">
          Pushes to <span className="mono">main</span> start a run
          automatically. You can also start one by hand.
        </EmptyState>
      ) : (
        <div className="table-wrap card flush">
          <table className="table clickable">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>Commit</th>
                <th>Branch</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => select(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') select(p.id)
                  }}
                  tabIndex={0}
                >
                  <td className="mono">#{p.number}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="commit-cell">
                    <span className="mono">{shortSha(p.commitSha)}</span>
                    {p.commitMessage ? (
                      <span className="muted truncate">{p.commitMessage}</span>
                    ) : null}
                  </td>
                  <td className="mono">{p.branch}</td>
                  <td>
                    <span className="tag">{p.trigger}</span>
                  </td>
                  <td className="muted nowrap">
                    {relativeTime(p.startedAt ?? p.createdAt)}
                  </td>
                  <td className="mono nowrap">
                    {p.startedAt ? duration(p.startedAt, p.finishedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
