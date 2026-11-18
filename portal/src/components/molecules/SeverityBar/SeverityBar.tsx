import { SEVERITIES, totalCount } from '@/features/security/security.severity'
import type { SeverityCounts } from '@/features/security/security.types'

interface SeverityBarProps {
  counts: SeverityCounts | undefined
  /** A per-severity legend instead of the "N high+" summary. */
  legend?: boolean
}

/** Stacked mini bar of finding counts, optionally with a legend. */
export default function SeverityBar({
  counts,
  legend = false,
}: SeverityBarProps) {
  const total = totalCount(counts)
  if (!counts || total === 0) {
    return <span className="muted small">No findings</span>
  }

  const label = SEVERITIES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ')

  return (
    <span className="sev-bar-wrap">
      <span className="sev-bar" role="img" aria-label={label} title={label}>
        {SEVERITIES.map((s) =>
          counts[s] > 0 ? (
            <span
              key={s}
              className={`sev-seg sev-${s}`}
              style={{ flexGrow: counts[s] }}
            />
          ) : null
        )}
      </span>
      {legend ? (
        <span className="sev-legend">
          {SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className="sev-legend-item">
              <span className={`sev-swatch sev-${s}`} />
              {counts[s]} {s}
            </span>
          ))}
        </span>
      ) : (
        <span className="sev-total">
          {counts.critical + counts.high > 0 ? (
            <strong className="sev-text-high">
              {counts.critical + counts.high} high+
            </strong>
          ) : (
            <span className="muted">{total}</span>
          )}
        </span>
      )}
    </span>
  )
}
