import { useState } from 'react'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import type { Tone } from '@/lib/status'
import type {
  ComponentVersion,
  UpdateState,
} from '@/features/versions/versions.types'

interface ComponentVersionRowProps {
  component: ComponentVersion
  isAdmin: boolean
  /** True while this row's request is on its way. */
  busy: boolean
  onUpdate: (id: string, version: string) => void
  onRollback: (id: string) => void
}

const STATE: Record<UpdateState, { label: string; tone: Tone }> = {
  'up-to-date': { label: 'Up to date', tone: 'success' },
  'update-available': { label: 'Update available', tone: 'running' },
  'major-available': { label: 'Major version available', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'pending' },
}

const SOURCE_LABEL = { admin: 'set by admin', env: 'from .env' } as const

const tagOf = (image: string) => image.slice(image.lastIndexOf(':') + 1)

/** One platform component: its version, what is newer, and the admin's actions. */
export default function ComponentVersionRow({
  component: c,
  isAdmin,
  busy,
  onUpdate,
  onRollback,
}: ComponentVersionRowProps) {
  const preferred = c.recommended ?? c.latest ?? ''
  const [choice, setChoice] = useState('')
  const target =
    choice && c.candidates.some((v) => v.version === choice)
      ? choice
      : preferred
  const state = STATE[c.state]
  const locked = busy || Boolean(c.activeUpdate) || !c.manageable
  const lockReason = !c.manageable
    ? c.reason
    : c.activeUpdate
      ? 'An update of this component is in progress'
      : undefined
  const canRollBack = c.downgrade && Boolean(c.previousImage)

  return (
    <tr>
      <td>
        <div className="component-name">{c.name}</div>
        <div className="muted small">{c.description}</div>
        {c.note ? <div className="version-note small">{c.note}</div> : null}
      </td>
      <td>
        <div className="mono">{c.version}</div>
        <div className="muted small mono version-image" title={c.image}>
          {c.image.slice(0, c.image.lastIndexOf(':'))}
        </div>
        {c.source !== 'default' ? (
          <span className="tag">{SOURCE_LABEL[c.source]}</span>
        ) : null}
        {c.running ? (
          <div className="version-note small">
            Running <span className="mono">{c.running}</span>
          </div>
        ) : null}
        {c.pulled === false ? (
          <div className="muted small">Not downloaded to the cluster yet</div>
        ) : null}
      </td>
      <td>
        <span title={c.checkError}>
          <StatusBadge status={c.state} label={state.label} tone={state.tone} />
        </span>
        {c.latest && c.latest !== c.recommended ? (
          <div className="muted small">
            Latest <span className="mono">{c.latest}</span>
            {c.recommended ? null : ' (major)'}
          </div>
        ) : null}
        {c.checkError ? (
          <div className="muted small version-error">{c.checkError}</div>
        ) : null}
      </td>
      <td>
        {isAdmin ? (
          <div className="version-actions" title={lockReason}>
            {c.candidates.length > 0 ? (
              <>
                <select
                  className="input"
                  value={target}
                  disabled={locked}
                  aria-label={`Version of ${c.name}`}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  {c.candidates.map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version}
                      {v.major ? ' (major)' : ''}
                      {v.version === c.recommended ? ' (recommended)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={locked || !target}
                  onClick={() => onUpdate(c.id, target)}
                >
                  Update
                </button>
              </>
            ) : null}
            {canRollBack ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={locked}
                title={`Back to ${c.previousImage}`}
                onClick={() => onRollback(c.id)}
              >
                Roll back to {tagOf(c.previousImage!)}
              </button>
            ) : null}
            {!c.manageable ? (
              <span className="muted small">Read-only here</span>
            ) : null}
          </div>
        ) : (
          <span className="muted small">
            {c.candidates.length ? 'Admins can update' : '—'}
          </span>
        )}
      </td>
    </tr>
  )
}
