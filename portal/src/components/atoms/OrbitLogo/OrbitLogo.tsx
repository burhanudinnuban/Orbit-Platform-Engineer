interface OrbitLogoProps {
  size?: number
}

/** The Orbit mark: a planet on a tilted ring. Inherits the text colour. */
export default function OrbitLogo({ size = 22 }: OrbitLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="logo"
    >
      <circle cx="16" cy="16" r="6" fill="currentColor" />
      <ellipse
        cx="16"
        cy="16"
        rx="14"
        ry="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        transform="rotate(-30 16 16)"
        opacity="0.75"
      />
    </svg>
  )
}
