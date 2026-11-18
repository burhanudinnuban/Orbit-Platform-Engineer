import type { Severity } from '@/features/security/security.types'

interface SeverityPillProps {
  severity: Severity
}

export default function SeverityPill({ severity }: SeverityPillProps) {
  return <span className={`sev-pill sev-${severity}`}>{severity}</span>
}
