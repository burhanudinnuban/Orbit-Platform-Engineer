import { shellQuote } from '../../lib/util.js'
import type { ExtractedReport, ReportTool } from './security.types.js'

export const REPORT_BEGIN = '::orbit-report-begin::'
export const REPORT_END = '::orbit-report-end::'
export const DEFAULT_REPORT_DIR = '/workspace/.orbit-reports'
export const REPORT_TOOLS: readonly ReportTool[] = [
  'semgrep',
  'gitleaks',
  'trivy-fs',
  'trivy-image',
  'zap',
]

export function isReportTool(v: string): v is ReportTool {
  return (REPORT_TOOLS as readonly string[]).includes(v)
}

/** Kubernetes log timestamps (`kubectl logs --timestamps`): RFC3339 followed by one space. */
const TIMESTAMP_PREFIX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}) /

/**
 * Extracts the report blocks that a CI scan pod prints:
 *
 *   ::orbit-report-begin::<tool>
 *   <body>
 *   ::orbit-report-end::<tool>
 *
 * Works with LF or CRLF line endings and with or without Kubernetes timestamp prefixes.
 * Unknown tools, unterminated blocks and blocks with a mismatched end marker are ignored.
 */
export function extractReports(log: string): ExtractedReport[] {
  const reports: ExtractedReport[] = []
  let current: { tool: string; timestamped: boolean; lines: string[] } | null =
    null

  for (const rawLine of log.split(/\r?\n/)) {
    const begin = rawLine.indexOf(REPORT_BEGIN)
    if (begin >= 0) {
      // A new begin marker abandons any unterminated block.
      current = {
        tool: rawLine.slice(begin + REPORT_BEGIN.length).trim(),
        timestamped: TIMESTAMP_PREFIX.test(rawLine.slice(0, begin)),
        lines: [],
      }
      continue
    }
    if (!current) continue

    const line = current.timestamped
      ? rawLine.replace(TIMESTAMP_PREFIX, '')
      : rawLine
    const end = line.indexOf(REPORT_END)
    if (end >= 0) {
      const endTool = line.slice(end + REPORT_END.length).trim()
      if (endTool === current.tool) {
        // The report may not end with a newline, so the marker can share a line with the body.
        const before = line.slice(0, end)
        if (before.trim() !== '') current.lines.push(before)
        if (isReportTool(current.tool)) {
          reports.push({
            tool: current.tool,
            text: current.lines.join('\n').trim(),
          })
        }
      }
      current = null
      continue
    }
    current.lines.push(line)
  }
  return reports
}

/**
 * POSIX sh (busybox compatible) script that prints every report between markers,
 * printing `{}` for reports that are missing or empty.
 */
export function reportDumpScript(
  tools: ReportTool[],
  dir: string = DEFAULT_REPORT_DIR
): string {
  const lines = ['set -u']
  for (const tool of tools) {
    if (!isReportTool(tool))
      throw new Error(`Unknown report tool: ${String(tool)}`)
    const file = shellQuote(`${dir.replace(/\/+$/, '')}/${tool}.json`)
    lines.push(
      `echo ${shellQuote(REPORT_BEGIN + tool)}`,
      `if [ -s ${file} ]; then cat ${file}; echo; else echo '{}'; fi`,
      `echo ${shellQuote(REPORT_END + tool)}`
    )
  }
  return `${lines.join('\n')}\n`
}

/** Masks credentials embedded in URLs, e.g. `http://user:token@host` → `http://****@host`. */
export function stripSecretsFromLog(log: string): string {
  return log.replace(/\b(https?:\/\/)[^\s/@'"]+@/gi, '$1****@')
}
