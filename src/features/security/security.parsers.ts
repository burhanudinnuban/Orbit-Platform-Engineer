import { createHash } from 'node:crypto'
import type { Severity } from '../../types/contract.js'
import { severityRank } from './security.policy.js'
import type { RawFinding, ReportTool } from './security.types.js'

type Rec = Record<string, unknown>

// ───────────────────────── helpers ─────────────────────────

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v))
    return Number.parseInt(v, 10)
  return undefined
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(flat)
  return truncate(m?.[1] ?? flat, 160)
}

function joinParts(parts: (string | undefined)[]): string | undefined {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join('\n\n')
  return text === '' ? undefined : text
}

/** Normalizes a scanned file path so it is stable across workspaces and OSes. */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/workspace\//, '')
    .replace(/^(\.\/)+/, '')
}

/** Stable 16-char hex fingerprint built from the identifying parts of a finding. */
export function fingerprint(...parts: (string | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((p) => p ?? '').join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

/** Keeps one finding per fingerprint (the most severe one), preserving first-seen order. */
function dedupe(findings: RawFinding[]): RawFinding[] {
  const byFingerprint = new Map<string, RawFinding>()
  for (const f of findings) {
    const existing = byFingerprint.get(f.fingerprint)
    if (!existing || severityRank(f.severity) > severityRank(existing.severity))
      byFingerprint.set(f.fingerprint, f)
  }
  return [...byFingerprint.values()]
}

/** Removes every occurrence of the given sensitive values from a text. */
function redact(
  text: string | undefined,
  secrets: (string | undefined)[]
): string | undefined {
  if (text === undefined) return undefined
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]')
  }
  return out
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => HTML_ENTITIES[e] ?? e)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

// ───────────────────────── semgrep ─────────────────────────

function semgrepSeverity(
  severity: string | undefined,
  impact: string | undefined,
  confidence: string | undefined
): Severity {
  switch (severity?.toUpperCase()) {
    case 'ERROR':
      return impact?.toUpperCase() === 'HIGH' &&
        confidence?.toUpperCase() === 'HIGH'
        ? 'critical'
        : 'high'
    case 'WARNING':
      return 'medium'
    case 'INFO':
      return 'low'
    // Newer semgrep releases emit these directly.
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'MEDIUM':
      return 'medium'
    case 'LOW':
      return 'low'
    case 'INVENTORY':
    case 'EXPERIMENT':
      return 'info'
    default:
      // Unknown or missing severity: don't hide it, but don't block on it either.
      return 'medium'
  }
}

function cweList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()]
  return asArray(v)
    .map(str)
    .filter((s): s is string => s !== undefined)
}

/** Parses `semgrep scan --json` output. */
export function parseSemgrep(json: unknown): RawFinding[] {
  if (!isRecord(json)) return []
  const out: RawFinding[] = []

  for (const r of asArray(json.results)) {
    if (!isRecord(r)) continue
    const ruleId = str(r.check_id)
    const path = str(r.path)
    if (!ruleId || !path) continue

    const start = isRecord(r.start) ? r.start : {}
    const extra = isRecord(r.extra) ? r.extra : {}
    const metadata = isRecord(extra.metadata) ? extra.metadata : {}
    const line = int(start.line)
    const location =
      line !== undefined
        ? `${normalizePath(path)}:${line}`
        : normalizePath(path)
    const message = str(extra.message)
    const cwe = cweList(metadata.cwe)
    const shortRule = ruleId.split('.').pop() ?? ruleId

    out.push({
      tool: 'semgrep',
      category: 'sast',
      severity: semgrepSeverity(
        str(extra.severity),
        str(metadata.impact),
        str(metadata.confidence)
      ),
      title: message ? firstSentence(message) : shortRule,
      description: joinParts([
        message ? truncate(message, 2000) : undefined,
        cwe.length > 0 ? `CWE: ${cwe.join('; ')}` : undefined,
      ]),
      ruleId,
      location,
      fingerprint: fingerprint('semgrep', ruleId, location),
    })
  }
  return dedupe(out)
}

// ───────────────────────── gitleaks ─────────────────────────

/** Parses a gitleaks JSON report. Secret values are never copied into findings. */
export function parseGitleaks(json: unknown): RawFinding[] {
  const out: RawFinding[] = []

  for (const leak of asArray(json)) {
    if (!isRecord(leak)) continue
    const ruleId = str(leak.RuleID)
    const file = str(leak.File)
    if (!ruleId || !file) continue

    const secrets = [
      typeof leak.Secret === 'string' ? leak.Secret : undefined,
      typeof leak.Match === 'string' ? leak.Match : undefined,
    ]
    const line = int(leak.StartLine)
    const location =
      line !== undefined
        ? `${normalizePath(file)}:${line}`
        : normalizePath(file)
    const commit = str(leak.Commit)

    out.push({
      tool: 'gitleaks',
      category: 'secret',
      severity: 'high',
      title:
        redact(str(leak.Description), secrets) ??
        `Secret matched rule ${ruleId}`,
      description:
        `A hard-coded secret matching rule '${ruleId}' was found` +
        (commit ? ` in commit ${commit.slice(0, 12)}` : '') +
        '. Rotate the credential and move it to a secret store.',
      ruleId,
      location: redact(location, secrets),
      fingerprint: fingerprint('gitleaks', ruleId, location),
    })
  }
  return dedupe(out)
}

// ───────────────────────── trivy ─────────────────────────

function trivySeverity(s: string | undefined): Severity {
  switch (s?.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'MEDIUM':
      return 'medium'
    case 'LOW':
      return 'low'
    default:
      return 'info' // UNKNOWN or missing
  }
}

/**
 * Image targets look like `registry:5000/app:<sha> (alpine 3.20.3)`. The tag changes on every build,
 * so it is dropped from the fingerprint to keep findings stable across pipelines.
 */
function stableTarget(target: string, category: 'sca' | 'image'): string {
  if (category !== 'image') return normalizePath(target)
  const m = /^(\S+)(\s+\(.*\))?$/.exec(target)
  if (!m?.[2]) return normalizePath(target)
  let ref = (m[1] ?? '').replace(/@sha256:[a-f0-9]+$/i, '')
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  if (colon > slash) ref = ref.slice(0, colon)
  return `${ref}${m[2]}`
}

/** Parses `trivy fs|image --format json` output. */
export function parseTrivy(
  json: unknown,
  category: 'sca' | 'image'
): RawFinding[] {
  if (!isRecord(json)) return []
  const out: RawFinding[] = []

  for (const result of asArray(json.Results)) {
    if (!isRecord(result)) continue
    const target = str(result.Target) ?? 'unknown target'
    const fpTarget = stableTarget(target, category)

    for (const v of asArray(result.Vulnerabilities)) {
      if (!isRecord(v)) continue
      const id = str(v.VulnerabilityID)
      const pkg = str(v.PkgName)
      if (!id || !pkg) continue

      const installed = str(v.InstalledVersion) ?? 'unknown'
      const fixed = str(v.FixedVersion)
      const pkgRef = `${pkg}@${installed}`
      const title = str(v.Title)
      const desc = str(v.Description)

      out.push({
        tool: 'trivy',
        category,
        severity: trivySeverity(str(v.Severity)),
        title: title ? truncate(`${id}: ${title}`, 200) : `${id} in ${pkg}`,
        description: joinParts([
          desc ? truncate(desc, 1500) : undefined,
          fixed
            ? `Fixed in ${pkg} ${fixed} (installed ${installed}).`
            : `No fixed version of ${pkg} is available yet.`,
          str(v.PrimaryURL),
        ]),
        ruleId: id,
        location: `${pkgRef} (${target})`,
        fingerprint: fingerprint('trivy', id, fpTarget, pkgRef),
      })
    }

    for (const s of asArray(result.Secrets)) {
      if (!isRecord(s)) continue
      const ruleId = str(s.RuleID)
      if (!ruleId) continue
      const line = int(s.StartLine)
      const location =
        line !== undefined
          ? `${normalizePath(target)}:${line}`
          : normalizePath(target)
      const secrets = [typeof s.Match === 'string' ? s.Match : undefined]

      out.push({
        tool: 'trivy',
        category: 'secret',
        severity: trivySeverity(str(s.Severity)),
        title: redact(str(s.Title), secrets) ?? `Secret matched rule ${ruleId}`,
        description: `A hard-coded secret matching rule '${ruleId}' was found. Rotate the credential and move it to a secret store.`,
        ruleId,
        location,
        fingerprint: fingerprint('trivy', ruleId, fpTarget),
      })
    }

    for (const m of asArray(result.Misconfigurations)) {
      if (!isRecord(m)) continue
      const status = str(m.Status)
      if (status && status.toUpperCase() !== 'FAIL') continue
      const id = str(m.ID) ?? str(m.AVDID)
      if (!id) continue
      const title = str(m.Title)

      out.push({
        tool: 'trivy',
        category: 'sast',
        severity: trivySeverity(str(m.Severity)),
        title: title ? truncate(`${id}: ${title}`, 200) : id,
        description: joinParts([
          str(m.Message),
          str(m.Resolution),
          str(m.PrimaryURL),
        ]),
        ruleId: id,
        location: normalizePath(target),
        fingerprint: fingerprint('trivy', id, fpTarget),
      })
    }
  }
  return dedupe(out)
}

// ───────────────────────── ZAP ─────────────────────────

function zapSeverity(riskcode: number | undefined): Severity {
  switch (riskcode) {
    case 3:
      return 'high'
    case 2:
      return 'medium'
    case 1:
      return 'low'
    default:
      return 'info'
  }
}

/** Parses the JSON report from `zap-baseline.py -J`. */
export function parseZap(json: unknown): RawFinding[] {
  if (!isRecord(json)) return []
  const out: RawFinding[] = []

  for (const site of asArray(json.site)) {
    if (!isRecord(site)) continue
    const siteName = str(site['@name']) ?? str(site['@host']) ?? ''

    for (const alert of asArray(site.alerts)) {
      if (!isRecord(alert)) continue
      const ruleId = str(alert.alertRef) ?? str(alert.pluginid)
      if (!ruleId) continue

      const uris = asArray(alert.instances)
        .filter(isRecord)
        .map((i) => str(i.uri))
        .filter((u): u is string => u !== undefined)
      const first = uris[0]
      const location =
        first !== undefined
          ? uris.length > 1
            ? `${first} (+${uris.length - 1} more)`
            : first
          : siteName || undefined
      const desc = str(alert.desc)
      const solution = str(alert.solution)

      out.push({
        tool: 'zap',
        category: 'dast',
        severity: zapSeverity(int(alert.riskcode)),
        title: str(alert.alert) ?? str(alert.name) ?? `ZAP alert ${ruleId}`,
        description: joinParts([
          desc ? truncate(stripHtml(desc), 1500) : undefined,
          solution
            ? `Solution: ${truncate(stripHtml(solution), 800)}`
            : undefined,
        ]),
        ruleId,
        location,
        fingerprint: fingerprint('zap', ruleId, siteName),
      })
    }
  }
  return dedupe(out)
}

// ───────────────────────── dispatch ─────────────────────────

export function parseReport(tool: ReportTool, text: string): RawFinding[] {
  const body = (text ?? '').replace(/^\uFEFF/, '')
  if (body.trim() === '') throw new Error(`The ${tool} report is empty`)

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (err) {
    throw new Error(
      `The ${tool} report is not valid JSON: ${(err as Error).message}`,
      { cause: err }
    )
  }

  switch (tool) {
    case 'semgrep':
      return parseSemgrep(json)
    case 'gitleaks':
      return parseGitleaks(json)
    case 'trivy-fs':
      return parseTrivy(json, 'sca')
    case 'trivy-image':
      return parseTrivy(json, 'image')
    case 'zap':
      return parseZap(json)
    default: {
      const unknownTool: never = tool
      throw new Error(`Unknown report tool: ${String(unknownTool)}`)
    }
  }
}
