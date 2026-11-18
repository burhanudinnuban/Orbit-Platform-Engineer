import { statusLabel, toneFor, type Tone } from '@/lib/status'

interface StatusBadgeProps {
  status: string
  label?: string
  /** Overrides the colour the status would normally get. */
  tone?: Tone
}

export default function StatusBadge({ status, label, tone }: StatusBadgeProps) {
  const t = tone ?? toneFor(status)

  return (
    <span className={`badge tone-${t}`} title={status}>
      <span className="dot" aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  )
}
