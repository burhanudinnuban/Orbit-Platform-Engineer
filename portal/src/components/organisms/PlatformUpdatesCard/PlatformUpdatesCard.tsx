import { useState } from 'react'
import StatusBadge from '@/components/atoms/StatusBadge/StatusBadge'
import PlatformUpdateLog from '@/components/molecules/PlatformUpdateLog/PlatformUpdateLog'
import type { PlatformUpdate } from '@/features/versions/versions.types'
import { relativeTime } from '@/lib/format'

interface PlatformUpdatesCardProps {
  updates: PlatformUpdate[]
}

const tagOf = (image?: string) =>
  image ? image.slice(image.lastIndexOf(':') + 1) : '?'

/** Recent platform updates, newest first; a click shows the log. */
export default function PlatformUpdatesCard({
  updates,
}: PlatformUpdatesCardProps) {
  const running = updates.find(
    (u) => u.status === 'running' || u.status === 'queued'
  )
  const [openId, setOpenId] = useState<string>()
  const shown = openId ?? running?.id

  return (
    <section className="card">
      <h2>Updates</h2>
      {updates.length === 0 ? (
        <p className="muted small">
          No updates yet. Updates run one at a time; each one is checked and
          rolled back when the new version does not come up.
        </p>
      ) : (
        <ul className="update-list">
          {updates.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className={`update-row ${shown === u.id ? 'open' : ''}`}
                aria-expanded={shown === u.id}
                onClick={() => setOpenId(shown === u.id ? '' : u.id)}
              >
                <StatusBadge status={u.status} />
                <span className="component-name">{u.componentName}</span>
                <span className="mono small">
                  {u.kind === 'rollback' ? 'back to ' : ''}
                  {tagOf(u.fromImage)} → {tagOf(u.toImage)}
                </span>
                <span className="muted small">
                  {relativeTime(u.finishedAt ?? u.startedAt ?? u.createdAt)}
                </span>
              </button>
              {shown === u.id ? <PlatformUpdateLog update={u} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
