import { toneFor } from '@/lib/status'

interface StatusIconProps {
  status: string
  size?: number
}

/** Round icon used in timelines and stage graphs. */
export default function StatusIcon({ status, size = 18 }: StatusIconProps) {
  const tone = toneFor(status)
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    'aria-label': status,
    role: 'img',
  } as const

  if (status === 'running') {
    return (
      <svg {...common} className={`status-icon tone-${tone} spin`}>
        <circle
          cx="10"
          cy="10"
          r="7.5"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <path
          d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (tone === 'success') {
    return (
      <svg {...common} className={`status-icon tone-${tone}`}>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path
          d="M6 10.3l2.6 2.6L14.2 7.3"
          fill="none"
          stroke="var(--surface)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (tone === 'failed') {
    return (
      <svg {...common} className={`status-icon tone-${tone}`}>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path
          d="M7 7l6 6M13 7l-6 6"
          stroke="var(--surface)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (status === 'waiting') {
    return (
      <svg {...common} className={`status-icon tone-${tone}`}>
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M10 5.5V10l3 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (status === 'skipped' || status === 'canceled') {
    return (
      <svg {...common} className={`status-icon tone-${tone}`}>
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M6.5 10h7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (tone === 'warning') {
    return (
      <svg {...common} className={`status-icon tone-${tone}`}>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path
          d="M10 5.5v5.5"
          stroke="var(--surface)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="10" cy="14.3" r="1.2" fill="var(--surface)" />
      </svg>
    )
  }
  return (
    <svg {...common} className={`status-icon tone-${tone}`}>
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="3 2.6"
      />
    </svg>
  )
}
