import type {
  FindingCategory,
  ScanTool,
  Severity,
  SeverityCounts,
} from './security.types'

export const SEVERITIES: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
]

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export const CATEGORIES: { id: FindingCategory; label: string }[] = [
  { id: 'sast', label: 'SAST' },
  { id: 'sca', label: 'Dependencies' },
  { id: 'secret', label: 'Secrets' },
  { id: 'image', label: 'Image' },
  { id: 'dast', label: 'DAST' },
]

export const TOOLS: ScanTool[] = ['semgrep', 'trivy', 'gitleaks', 'zap']

/** The lowest severity rank each gate blocks; `off` blocks nothing. */
export const GATE_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
}

export const GATE_TEXT: Record<string, string> = {
  critical: 'blocks critical',
  high: 'blocks high and above',
  medium: 'blocks medium and above',
  off: 'report only',
}

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
}

export function totalCount(counts: SeverityCounts | undefined): number {
  if (!counts) return 0
  return SEVERITIES.reduce((sum, s) => sum + (counts[s] ?? 0), 0)
}
