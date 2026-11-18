import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Severity } from '../src/types/contract.js'
import {
  parseGitleaks,
  parseReport,
  parseSemgrep,
  parseTrivy,
  parseZap,
} from '../src/features/security/security.parsers.js'
import {
  countBySeverity,
  emptyCounts,
  evaluatePolicy,
  severityAtLeast,
} from '../src/features/security/security.policy.js'
import {
  REPORT_BEGIN,
  REPORT_END,
  extractReports,
  reportDumpScript,
  stripSecretsFromLog,
} from '../src/features/security/security.reports.js'
import type {
  RawFinding,
  ReportTool,
} from '../src/features/security/security.types.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'security')
const load = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8')
const loadJson = (name: string): unknown => JSON.parse(load(name)) as unknown

function byRule(findings: RawFinding[], ruleId: string): RawFinding {
  const f = findings.find((x) => x.ruleId === ruleId)
  assert.ok(f, `expected a finding for rule ${ruleId}`)
  return f
}

function assertFingerprints(findings: RawFinding[]): void {
  for (const f of findings) assert.match(f.fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(
    new Set(findings.map((f) => f.fingerprint)).size,
    findings.length,
    'fingerprints are unique'
  )
}

function finding(severity: Severity, n = 0): RawFinding {
  return {
    tool: 'semgrep',
    category: 'sast',
    severity,
    title: `t${n}`,
    ruleId: `r${severity}${n}`,
    fingerprint: `${severity}${n}`,
  }
}

const MALFORMED: unknown[] = [
  null,
  undefined,
  42,
  'text',
  [],
  {},
  { results: 'nope' },
  { Results: {} },
  { site: null },
]

describe('parseSemgrep', () => {
  const findings = parseSemgrep(loadJson('semgrep.json'))

  it('normalizes valid results, skips malformed entries and dedupes', () => {
    assert.equal(findings.length, 4)
    assertFingerprints(findings)
    for (const f of findings) {
      assert.equal(f.tool, 'semgrep')
      assert.equal(f.category, 'sast')
    }
  })

  it('maps severities (ERROR + HIGH/HIGH → critical)', () => {
    assert.equal(
      byRule(
        findings,
        'javascript.lang.security.audit.code-string-concat.code-string-concat'
      ).severity,
      'critical'
    )
    assert.equal(
      byRule(
        findings,
        'javascript.express.security.injection.tainted-sql-string.tainted-sql-string'
      ).severity,
      'high'
    )
    assert.equal(
      byRule(
        findings,
        'javascript.express.security.audit.xss.direct-response-write.direct-response-write'
      ).severity,
      'medium'
    )
    assert.equal(
      byRule(
        findings,
        'javascript.lang.best-practice.leftover_debugging.javascript-debugger'
      ).severity,
      'low'
    )
  })

  it('builds normalized path:line locations', () => {
    assert.equal(
      byRule(
        findings,
        'javascript.lang.security.audit.code-string-concat.code-string-concat'
      ).location,
      'src/eval.js:10'
    )
    assert.equal(
      byRule(
        findings,
        'javascript.express.security.injection.tainted-sql-string.tainted-sql-string'
      ).location,
      'src/db.js:17'
    )
    assert.equal(
      byRule(
        findings,
        'javascript.lang.best-practice.leftover_debugging.javascript-debugger'
      ).location,
      'src/routes/health.js:5'
    )
  })

  it('uses the first sentence as the title and includes CWE in the description', () => {
    const xss = byRule(
      findings,
      'javascript.express.security.audit.xss.direct-response-write.direct-response-write'
    )
    assert.equal(
      xss.title,
      'Detected directly writing to a Response object from user-defined input.'
    )
    assert.match(xss.description ?? '', /CWE-79/)
    assert.match(
      byRule(
        findings,
        'javascript.lang.security.audit.code-string-concat.code-string-concat'
      ).description ?? '',
      /CWE-95/
    )
  })

  it('handles newer CRITICAL/HIGH/MEDIUM/LOW severities', () => {
    const out = parseSemgrep({
      results: [
        {
          check_id: 'x.y',
          path: 'a.js',
          start: { line: 1 },
          extra: { severity: 'CRITICAL', message: 'Bad.' },
        },
      ],
    })
    assert.equal(out[0]?.severity, 'critical')
  })

  it('never throws on malformed input', () => {
    for (const input of MALFORMED) assert.deepEqual(parseSemgrep(input), [])
    assert.deepEqual(
      parseSemgrep({
        results: [null, 1, {}, { check_id: 'a' }, { path: 'b' }],
      }),
      []
    )
  })
})

describe('parseGitleaks', () => {
  const raw = loadJson('gitleaks.json') as Array<Record<string, unknown>>
  const findings = parseGitleaks(raw)

  it('normalizes leaks and dedupes', () => {
    assert.equal(findings.length, 2)
    assertFingerprints(findings)
    for (const f of findings) {
      assert.equal(f.tool, 'gitleaks')
      assert.equal(f.category, 'secret')
      assert.equal(f.severity, 'high')
    }
  })

  it('uses the rule description as title and File:StartLine as location', () => {
    const aws = byRule(findings, 'aws-access-token')
    assert.equal(aws.title, 'AWS Access Key')
    assert.equal(aws.location, 'config/aws.env:3')
    assert.match(aws.description ?? '', /a1b2c3d4e5f6/)
    assert.equal(
      byRule(findings, 'generic-api-key').location,
      'src/payments.js:12'
    )
  })

  it('never leaks the Secret or Match values', () => {
    const serialized = JSON.stringify(findings)
    for (const leak of raw) {
      if (typeof leak !== 'object' || leak === null) continue
      for (const key of ['Secret', 'Match'] as const) {
        const value = leak[key]
        if (typeof value === 'string')
          assert.ok(!serialized.includes(value), `${key} value leaked`)
      }
    }
  })

  it('redacts a secret that appears inside the description', () => {
    const out = parseGitleaks([
      {
        RuleID: 'r',
        File: 'f',
        StartLine: 1,
        Description: 'token supersecretvalue found',
        Secret: 'supersecretvalue',
      },
    ])
    assert.equal(out[0]?.title, 'token [REDACTED] found')
  })

  it('never throws on malformed input', () => {
    for (const input of MALFORMED) assert.deepEqual(parseGitleaks(input), [])
    assert.deepEqual(parseGitleaks([{}, { RuleID: 'x' }, { File: 'y' }]), [])
  })
})

describe('parseTrivy (fs)', () => {
  const findings = parseTrivy(loadJson('trivy-fs.json'), 'sca')

  it('collects vulnerabilities, failed misconfigurations and secrets', () => {
    assert.equal(findings.length, 7)
    assertFingerprints(findings)
    assert.equal(findings.filter((f) => f.category === 'sca').length, 4)
    assert.equal(findings.filter((f) => f.category === 'sast').length, 2)
    assert.equal(findings.filter((f) => f.category === 'secret').length, 1)
    assert.ok(findings.every((f) => f.tool === 'trivy'))
    assert.ok(
      !findings.some((f) => f.ruleId === 'DS001'),
      'PASS misconfigurations are skipped'
    )
  })

  it('maps severities directly (UNKNOWN → info)', () => {
    assert.equal(byRule(findings, 'CVE-2024-45590').severity, 'high')
    assert.equal(byRule(findings, 'CVE-2024-4067').severity, 'medium')
    assert.equal(byRule(findings, 'CVE-2024-43796').severity, 'low')
    assert.equal(byRule(findings, 'GHSA-0000-orbit-test').severity, 'info')
    assert.equal(byRule(findings, 'github-pat').severity, 'critical')
    assert.equal(byRule(findings, 'DS002').severity, 'high')
  })

  it('formats vulnerability location and mentions the fix', () => {
    const bp = byRule(findings, 'CVE-2024-45590')
    assert.equal(bp.location, 'body-parser@1.20.2 (package-lock.json)')
    assert.match(bp.title, /^CVE-2024-45590: body-parser/)
    assert.match(bp.description ?? '', /Fixed in body-parser 1\.20\.3/)
    assert.match(
      byRule(findings, 'GHSA-0000-orbit-test').description ?? '',
      /No fixed version/
    )
  })

  it('does not leak secret matches', () => {
    assert.ok(!JSON.stringify(findings).includes('ghp_orbitTestTokenNotReal'))
    assert.equal(byRule(findings, 'github-pat').location, 'src/config.js:4')
  })

  it('keeps secret fingerprints stable when the line moves', () => {
    const doc = loadJson('trivy-fs.json') as {
      Results: Array<{ Secrets?: Array<{ StartLine: number }> }>
    }
    const moved = structuredClone(doc)
    const secret = moved.Results[2]?.Secrets?.[0]
    assert.ok(secret)
    secret.StartLine = 99
    const before = byRule(findings, 'github-pat').fingerprint
    assert.equal(
      byRule(parseTrivy(moved, 'sca'), 'github-pat').fingerprint,
      before
    )
  })

  it('never throws on malformed input', () => {
    for (const input of MALFORMED)
      assert.deepEqual(parseTrivy(input, 'sca'), [])
    assert.deepEqual(
      parseTrivy(
        {
          Results: [
            null,
            { Vulnerabilities: [{}], Secrets: [{}], Misconfigurations: [{}] },
          ],
        },
        'image'
      ),
      []
    )
  })
})

describe('parseTrivy (image)', () => {
  const doc = loadJson('trivy-image.json')
  const findings = parseTrivy(doc, 'image')

  it('labels findings as image findings with mapped severities', () => {
    assert.equal(findings.length, 4)
    assertFingerprints(findings)
    assert.ok(findings.every((f) => f.category === 'image'))
    assert.equal(byRule(findings, 'CVE-2024-45491').severity, 'critical')
    assert.equal(byRule(findings, 'CVE-2024-6119').severity, 'high')
    assert.equal(
      byRule(findings, 'CVE-2024-45491').location,
      'libexpat@2.6.2-r0 (kind-registry:5000/payments:3f9c2ab (alpine 3.20.3))'
    )
  })

  it('keeps fingerprints stable across image tags', () => {
    const retagged = JSON.parse(
      JSON.stringify(doc).replaceAll('payments:3f9c2ab', 'payments:9d8e7f6')
    ) as unknown
    const after = parseTrivy(retagged, 'image')
    assert.deepEqual(
      after.map((f) => f.fingerprint),
      findings.map((f) => f.fingerprint)
    )
  })
})

describe('parseZap', () => {
  const findings = parseZap(loadJson('zap.json'))

  it('normalizes alerts and skips malformed ones', () => {
    assert.equal(findings.length, 4)
    assertFingerprints(findings)
    assert.ok(findings.every((f) => f.tool === 'zap' && f.category === 'dast'))
  })

  it('maps riskcode 3/2/1/0 to high/medium/low/info', () => {
    assert.equal(byRule(findings, '10062').severity, 'high')
    assert.equal(byRule(findings, '10038-1').severity, 'medium')
    assert.equal(byRule(findings, '10021').severity, 'low')
    assert.equal(byRule(findings, '10109').severity, 'info')
  })

  it('uses the first instance uri plus a count as location', () => {
    assert.equal(
      byRule(findings, '10038-1').location,
      'http://payments.payments-dev.svc.cluster.local/ (+2 more)'
    )
    assert.equal(
      byRule(findings, '10062').location,
      'http://payments.payments-dev.svc.cluster.local/api/customers'
    )
  })

  it('strips HTML from descriptions and decodes entities', () => {
    const csp = byRule(findings, '10038-1')
    assert.equal(csp.title, 'Content Security Policy (CSP) Header Not Set')
    assert.ok(!/[<>]/.test(csp.description ?? ''), 'no HTML tags')
    assert.match(csp.description ?? '', /XSS\) & data injection/)
    assert.match(csp.description ?? '', /Solution: Ensure that your web server/)
  })

  it('never throws on malformed input', () => {
    for (const input of MALFORMED) assert.deepEqual(parseZap(input), [])
    assert.deepEqual(
      parseZap({ site: [null, { alerts: [null, {}, { alert: 'x' }] }] }),
      []
    )
  })
})

describe('parseReport', () => {
  it('dispatches by tool', () => {
    assert.equal(parseReport('semgrep', load('semgrep.json')).length, 4)
    assert.equal(parseReport('gitleaks', load('gitleaks.json')).length, 2)
    assert.ok(
      parseReport('trivy-fs', load('trivy-fs.json')).some(
        (f) => f.category === 'sca'
      )
    )
    assert.ok(
      parseReport('trivy-image', load('trivy-image.json')).every(
        (f) => f.category === 'image'
      )
    )
    assert.equal(parseReport('zap', load('zap.json')).length, 4)
  })

  it('returns no findings for the {} placeholder of a missing report', () => {
    for (const tool of [
      'semgrep',
      'gitleaks',
      'trivy-fs',
      'trivy-image',
      'zap',
    ] as const)
      assert.deepEqual(parseReport(tool, '{}'), [])
  })

  it('accepts a UTF-8 BOM', () => {
    assert.equal(parseReport('zap', `\uFEFF${load('zap.json')}`).length, 4)
  })

  it('throws clear errors for empty or invalid reports', () => {
    assert.throws(() => parseReport('semgrep', ''), /semgrep report is empty/)
    assert.throws(() => parseReport('zap', '  \n '), /zap report is empty/)
    assert.throws(
      () => parseReport('trivy-fs', '{"Results": ['),
      /trivy-fs report is not valid JSON/
    )
  })
})

describe('extractReports', () => {
  const log = load('scan-log.txt')
  const expectedTools = ['semgrep', 'gitleaks', 'trivy-fs', 'zap']

  function check(reports: ReturnType<typeof extractReports>): void {
    assert.deepEqual(
      reports.map((r) => r.tool),
      expectedTools
    )
    for (const r of reports) {
      assert.doesNotThrow(
        () => JSON.parse(r.text),
        `${r.tool} body is valid JSON`
      )
      assert.ok(!r.text.includes('\r'))
      assert.ok(!r.text.includes('::orbit-report'))
    }
    assert.equal(parseReport('semgrep', reports[0]?.text ?? '').length, 1)
    assert.equal(parseReport('gitleaks', reports[1]?.text ?? '').length, 1)
    assert.equal(
      parseReport('zap', reports[3]?.text ?? '')[0]?.severity,
      'medium'
    )
  }

  it('extracts known, terminated blocks (unknown and unterminated are ignored)', () => {
    check(extractReports(log))
  })

  it('handles an end marker on the same line as the body', () => {
    const trivy = extractReports(log).find((r) => r.tool === 'trivy-fs')
    assert.equal(
      trivy?.text,
      '{"SchemaVersion":2,"ArtifactType":"filesystem","Results":[]}'
    )
  })

  it('tolerates CRLF line endings', () => {
    check(extractReports(log.replace(/\n/g, '\r\n')))
  })

  it('tolerates Kubernetes timestamp prefixes', () => {
    const stamped = log
      .split('\n')
      .map((line) => `2026-11-09T10:00:00.123456789Z ${line}`)
      .join('\n')
    check(extractReports(stamped))
  })

  it('ignores blocks with a mismatched end marker', () => {
    const text = `${REPORT_BEGIN}semgrep\n{}\n${REPORT_END}zap\n${REPORT_BEGIN}zap\n{"site":[]}\n${REPORT_END}zap\n`
    assert.deepEqual(extractReports(text), [
      { tool: 'zap', text: '{"site":[]}' },
    ])
  })

  it('returns nothing for logs without markers', () => {
    assert.deepEqual(extractReports(''), [])
    assert.deepEqual(extractReports('just\nnoise\n'), [])
  })
})

describe('reportDumpScript', () => {
  const tools: ReportTool[] = [
    'semgrep',
    'gitleaks',
    'trivy-fs',
    'trivy-image',
    'zap',
  ]

  it('prints begin/end markers and cats each report', () => {
    const script = reportDumpScript(tools)
    for (const tool of tools) {
      assert.ok(
        script.includes(`${REPORT_BEGIN}${tool}`),
        `begin marker for ${tool}`
      )
      assert.ok(
        script.includes(`${REPORT_END}${tool}`),
        `end marker for ${tool}`
      )
      assert.ok(
        script.includes(`'/workspace/.orbit-reports/${tool}.json'`),
        `cat path for ${tool}`
      )
    }
    assert.match(script, /echo '\{\}'/)
  })

  it('supports a custom directory and rejects unknown tools', () => {
    assert.ok(
      reportDumpScript(['zap'], '/zap/wrk/').includes("'/zap/wrk/zap.json'")
    )
    assert.throws(
      () => reportDumpScript(['bandit' as ReportTool]),
      /Unknown report tool/
    )
  })

  const sh = spawnSync('sh', ['-c', 'exit 0'])
  it(
    'round-trips through extractReports when run by sh',
    { skip: sh.status !== 0 ? 'sh is not available' : false },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'orbit-reports-')).replace(
        /\\/g,
        '/'
      )
      try {
        const semgrep = load('semgrep.json')
        writeFileSync(join(dir, 'semgrep.json'), semgrep)
        writeFileSync(join(dir, 'trivy-fs.json'), '')
        const run = spawnSync(
          'sh',
          ['-c', reportDumpScript(['semgrep', 'gitleaks', 'trivy-fs'], dir)],
          { encoding: 'utf8' }
        )
        assert.equal(run.status, 0, run.stderr)
        const reports = extractReports(run.stdout)
        assert.deepEqual(
          reports.map((r) => r.tool),
          ['semgrep', 'gitleaks', 'trivy-fs']
        )
        assert.equal(reports[0]?.text, semgrep.trim())
        assert.equal(reports[1]?.text, '{}')
        assert.equal(reports[2]?.text, '{}')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('stripSecretsFromLog', () => {
  it('masks credentials embedded in URLs', () => {
    const out = stripSecretsFromLog(load('scan-log.txt'))
    assert.ok(!out.includes('s3cr3t-token-value'))
    assert.ok(
      out.includes(
        'http://****@gitea.orbit-system.svc.cluster.local:3000/apps/payments.git'
      )
    )
  })

  it('masks token-only userinfo and leaves normal URLs alone', () => {
    assert.equal(
      stripSecretsFromLog('push https://ghp_abc123@git.example.com/x.git'),
      'push https://****@git.example.com/x.git'
    )
    const plain =
      'see https://example.com/path?email=a@b.com and http://host:8080/'
    assert.equal(stripSecretsFromLog(plain), plain)
  })
})

describe('policy', () => {
  it('counts by severity', () => {
    assert.deepEqual(emptyCounts(), {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    })
    assert.deepEqual(
      countBySeverity([finding('high'), finding('high', 1), finding('info')]),
      {
        critical: 0,
        high: 2,
        medium: 0,
        low: 0,
        info: 1,
      }
    )
  })

  it('compares severities', () => {
    assert.ok(severityAtLeast('critical', 'high'))
    assert.ok(severityAtLeast('high', 'high'))
    assert.ok(!severityAtLeast('medium', 'high'))
    assert.ok(severityAtLeast('info', 'info'))
    assert.ok(!severityAtLeast('info', 'low'))
  })

  const mixed = [
    finding('critical', 1),
    finding('critical', 2),
    finding('high', 1),
    finding('high', 2),
    finding('high', 3),
    finding('medium', 1),
    finding('low', 1),
  ]

  it("gate 'off' always passes", () => {
    const r = evaluatePolicy(mixed, 'off')
    assert.equal(r.passed, true)
    assert.deepEqual(r.violations, [])
    assert.equal(r.gate, 'off')
    assert.match(r.summary, /not enforced/)
  })

  it("gate 'critical' blocks only critical findings", () => {
    const r = evaluatePolicy(mixed, 'critical')
    assert.equal(r.passed, false)
    assert.equal(r.violations.length, 2)
    assert.ok(r.violations.every((v) => v.severity === 'critical'))
    assert.equal(evaluatePolicy([finding('high')], 'critical').passed, true)
  })

  it("gate 'high' blocks critical and high", () => {
    const r = evaluatePolicy(mixed, 'high')
    assert.equal(r.passed, false)
    assert.equal(r.violations.length, 5)
    assert.equal(
      r.summary,
      "2 critical, 3 high, 1 medium, 1 low — blocked by gate 'high' (5 violations)"
    )
    assert.deepEqual(r.counts, {
      critical: 2,
      high: 3,
      medium: 1,
      low: 1,
      info: 0,
    })
  })

  it("gate 'medium' blocks medium and above", () => {
    const r = evaluatePolicy(mixed, 'medium')
    assert.equal(r.violations.length, 6)
    const lowOnly = evaluatePolicy([finding('low'), finding('info')], 'medium')
    assert.equal(lowOnly.passed, true)
    assert.equal(lowOnly.summary, "1 low, 1 info — passed gate 'medium'")
  })

  it('passes with no findings and uses singular wording', () => {
    assert.equal(
      evaluatePolicy([], 'high').summary,
      "no findings — passed gate 'high'"
    )
    assert.equal(
      evaluatePolicy([finding('critical')], 'high').summary,
      "1 critical — blocked by gate 'high' (1 violation)"
    )
  })
})
