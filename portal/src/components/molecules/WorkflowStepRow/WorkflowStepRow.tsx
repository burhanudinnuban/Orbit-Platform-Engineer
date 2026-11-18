import { useState } from 'react'
import StatusIcon from '@/components/atoms/StatusIcon/StatusIcon'
import LogView from '@/components/molecules/LogView/LogView'
import type { StepView } from '@/features/apps/apps.types'
import { duration } from '@/lib/format'
import { toneFor } from '@/lib/status'

interface WorkflowStepRowProps {
  step: StepView
}

/**
 * One step of a workflow timeline. Running, waiting and failed steps open by
 * themselves; once the reader toggles one, their choice wins.
 */
export default function WorkflowStepRow({ step }: WorkflowStepRowProps) {
  const auto =
    step.status === 'running' ||
    step.status === 'waiting' ||
    step.status === 'failed'
  const [toggled, setToggled] = useState<boolean | null>(null)
  const expanded = toggled ?? auto

  return (
    <li
      className={`step tone-${toneFor(step.status)} ${expanded ? 'expanded' : ''}`}
    >
      <button
        type="button"
        className="step-head"
        onClick={() => setToggled(!expanded)}
        aria-expanded={expanded}
      >
        <span className="step-icon">
          <StatusIcon status={step.status} />
        </span>
        <span className="step-text">
          <span className="step-title">{step.title}</span>
          <span className="step-name mono">{step.name}</span>
        </span>
        <span className="step-meta">
          {step.attempts > 1 ? (
            <span className="tag">attempt {step.attempts}</span>
          ) : null}
          {step.status === 'waiting' ? (
            <span className="tag">waiting</span>
          ) : null}
          <span className="mono">
            {duration(step.startedAt, step.finishedAt)}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="step-body">
          {step.error ? <div className="inline-error">{step.error}</div> : null}
          <LogView
            text={step.logs}
            maxHeight={300}
            emptyText={
              step.status === 'pending' ? 'Not started yet.' : 'No output.'
            }
          />
        </div>
      ) : null}
    </li>
  )
}
