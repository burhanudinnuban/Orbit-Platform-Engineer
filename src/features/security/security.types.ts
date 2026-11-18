import type {
  FindingCategory,
  ScanTool,
  SecurityGate,
  Severity,
  SeverityCounts,
} from '../../types/contract.js'

/** A finding normalized from any scanner, before it is stored (no id/app/createdAt yet). */
export interface RawFinding {
  tool: ScanTool
  category: FindingCategory
  severity: Severity
  title: string
  description?: string
  ruleId: string
  location?: string
  fingerprint: string
}

/** Report files produced by CI scan/DAST stages (`/workspace/.orbit-reports/<tool>.json`). */
export type ReportTool =
  'semgrep' | 'gitleaks' | 'trivy-fs' | 'trivy-image' | 'zap'

export interface ExtractedReport {
  tool: ReportTool
  text: string
}

export interface PolicyResult {
  passed: boolean
  gate: SecurityGate
  counts: SeverityCounts
  violations: RawFinding[]
  summary: string
}
