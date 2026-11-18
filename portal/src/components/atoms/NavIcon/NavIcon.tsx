interface NavIconProps {
  /** A single stroked path on a 20×20 grid. */
  d: string
}

export default function NavIcon({ d }: NavIconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="nav-icon"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
