import type {
  SecurityGate,
  Severity,
  SeverityCounts,
} from '../../types/contract.js'
import type { PolicyResult, RawFinding } from './security.types.js'

/** Most severe first. */
export const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
]

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
}

export function countBySeverity(
  findings: readonly Pick<RawFinding, 'severity'>[]
): SeverityCounts {
  const counts = emptyCounts()
  for (const f of findings) counts[f.severity] += 1
  return counts
}

/** Numeric rank where a higher number means more severe (critical = 4, info = 0). */
export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.length - 1 - SEVERITY_ORDER.indexOf(s)
}

/** True when `s` is as severe as `threshold` or more severe. */
export function severityAtLeast(s: Severity, threshold: Severity): boolean {
  return severityRank(s) >= severityRank(threshold)
}

export function formatCounts(counts: SeverityCounts): string {
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]} ${s}`
  )
  return parts.length > 0 ? parts.join(', ') : 'no findings'
}

export function evaluatePolicy(
  findings: RawFinding[],
  gate: SecurityGate
): PolicyResult {
  const counts = countBySeverity(findings)
  const countsText = formatCounts(counts)

  if (gate === 'off') {
    return {
      passed: true,
      gate,
      counts,
      violations: [],
      summary: `${countsText} — security gate is off (not enforced)`,
    }
  }

  const violations = findings.filter((f) => severityAtLeast(f.severity, gate))
  const passed = violations.length === 0
  const summary = passed
    ? `${countsText} — passed gate '${gate}'`
    : `${countsText} — blocked by gate '${gate}' (${violations.length} violation${violations.length === 1 ? '' : 's'})`

  return { passed, gate, counts, violations, summary }
}
