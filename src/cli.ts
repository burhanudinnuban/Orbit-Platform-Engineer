#!/usr/bin/env node
import { parseArgs } from 'node:util'
import type {
  AppDetail,
  AppSummary,
  CreateAppRequest,
  DeploymentStatus,
  Finding,
  PipelineDetail,
  PipelineSummary,
  PlatformInfo,
  PlatformUpdate,
  VersionsResponse,
  WorkflowView,
} from './types/contract.js'

const API = (process.env.ORBIT_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  ''
)
// The admin token also passes the API-token check, and is what version updates need.
const TOKEN = process.env.ORBIT_ADMIN_TOKEN || process.env.ORBIT_API_TOKEN || ''

const color = process.stdout.isTTY
  ? {
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      reset: '\x1b[0m',
    }
  : { dim: '', bold: '', red: '', green: '', yellow: '', blue: '', reset: '' }

function paint(status: string): string {
  const s = status.toLowerCase()
  const c = /succeeded|ready|healthy|synced|passed/.test(s)
    ? color.green
    : /fail|degraded|error|critical|high/.test(s)
      ? color.red
      : /running|progressing|provisioning|waiting|queued/.test(s)
        ? color.blue
        : color.yellow
  return `${c}${status}${color.reset}`
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err: unknown) => {
    throw new Error(
      `Orbit API unreachable at ${API} (${err instanceof Error ? err.message : String(err)}). Is \`npm run dev\` running?`
    )
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
  if (!res.ok) {
    const e = data as { error?: string; details?: unknown } | undefined
    throw new Error(
      `${e?.error ?? res.statusText}${e?.details ? `\n  ${JSON.stringify(e.details)}` : ''}`
    )
  }
  return data as T
}

function table(rows: string[][]): void {
  // eslint-disable-next-line no-control-regex -- matching ANSI colour codes is the point
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => strip(r[i] ?? '').length))
  )
  for (const r of rows)
    console.log(
      r.map((c, i) => c + ' '.repeat(widths[i]! - strip(c).length)).join('  ')
    )
}

function printWorkflow(wf: WorkflowView): void {
  console.log(
    `${color.bold}${wf.kind} workflow${color.reset} ${paint(wf.status)}${wf.error ? ` — ${wf.error}` : ''}`
  )
  for (const s of wf.steps) {
    const icon = {
      succeeded: '✓',
      failed: '✗',
      running: '●',
      waiting: '…',
      pending: '○',
      skipped: '–',
    }[s.status]
    console.log(
      `  ${icon} ${s.title} ${color.dim}${s.status}${s.attempts > 1 ? `, attempt ${s.attempts}` : ''}${color.reset}`
    )
    if (s.status === 'failed' && s.error)
      console.log(`      ${color.red}${s.error}${color.reset}`)
  }
}

const HELP = `orbit — Orbit developer platform CLI

Usage:
  orbit platform                         Platform health and links
  orbit apps                             List applications
  orbit create <name> --team <team> [--template nextjs] [--language typescript|javascript]
                       [--env dev --env staging]
                       [--db] [--s3] [--queue] [--size small|medium|large] [--gate critical|high|medium|off]
                       [--description "..."]
                       --s3 and --queue create AWS resources (in Floci on a local platform)
  orbit status <name>                    Provisioning, deployments and findings
  orbit pipelines <name>                 Recent pipelines
  orbit run <name>                       Run the pipeline for main HEAD
  orbit logs <pipeline-id> [--stage <name>]
  orbit findings <name>                  Current security findings
  orbit delete <name> --yes              Tear down everything the platform created
  orbit watch <name>                     Follow provisioning until it settles
  orbit versions [--check]               Platform component versions and newer releases
  orbit update <component> <version>     Update one component (admin token)
  orbit update --all                     Every recommended update (admin token)

Environment: ORBIT_API_URL (default http://localhost:4000), ORBIT_API_TOKEN, ORBIT_ADMIN_TOKEN`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      team: { type: 'string' },
      template: { type: 'string', default: 'node-service' },
      language: { type: 'string' },
      check: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      env: { type: 'string', multiple: true },
      db: { type: 'boolean', default: false },
      s3: { type: 'boolean', default: false },
      queue: { type: 'boolean', default: false },
      size: { type: 'string', default: 'small' },
      gate: { type: 'string', default: 'high' },
      description: { type: 'string' },
      stage: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, arg] = positionals
  if (!command || values.help) return console.log(HELP)

  switch (command) {
    case 'platform': {
      const info = await api<PlatformInfo>('GET', '/api/platform')
      console.log(`Orbit ${info.version} · kube context ${info.kubeContext}\n`)
      table([
        ['COMPONENT', 'STATUS', 'DETAILS'],
        ...info.components.map((c) => [
          c.name,
          c.ok ? paint('healthy') : paint('error'),
          c.message ?? '',
        ]),
      ])
      console.log(
        `\nGit ${info.links.git} · Grafana ${info.links.grafana} · Prometheus ${info.links.prometheus}`
      )
      const cloudWhere = [info.cloud.region, info.links.cloud]
        .filter(Boolean)
        .join(', ')
      console.log(
        `Cloud: ${info.cloud.provider}${info.cloud.provider === 'none' ? '' : ` (${cloudWhere})`}`
      )
      console.log(
        `Templates: ${info.templates.map((t) => `${t.id} (${t.languages.join('/')})`).join(', ')} · Environments: ${info.environments.join(', ')}`
      )
      return
    }
    case 'apps': {
      const apps = await api<AppSummary[]>('GET', '/api/apps')
      if (!apps.length)
        return console.log(
          'No applications yet. Create one with `orbit create <name> --team <team>`.'
        )
      table([
        ['NAME', 'TEAM', 'STATUS', 'PIPELINE', 'DEPLOYMENTS', 'FINDINGS'],
        ...apps.map((a) => [
          a.name,
          a.team,
          paint(a.status),
          a.latestPipeline
            ? `#${a.latestPipeline.number} ${paint(a.latestPipeline.status)}`
            : '-',
          a.deployments.map((d) => `${d.env}:${paint(d.health)}`).join(' '),
          `${a.findings.critical}C ${a.findings.high}H ${a.findings.medium}M`,
        ]),
      ])
      return
    }
    case 'create': {
      if (!arg || !values.team)
        throw new Error('usage: orbit create <name> --team <team>')
      const body: CreateAppRequest = {
        name: arg,
        team: values.team,
        template: values.template!,
        language: values.language,
        description: values.description,
        environments: values.env?.length ? values.env : ['dev'],
        options: {
          database: values.db!,
          objectStorage: values.s3!,
          queue: values.queue!,
          size: values.size as CreateAppRequest['options']['size'],
          securityGate:
            values.gate as CreateAppRequest['options']['securityGate'],
        },
      }
      const created = await api<AppDetail>('POST', '/api/apps', body)
      console.log(
        `Created ${color.bold}${created.name}${color.reset}; provisioning has started.`
      )
      console.log(`Follow along: orbit watch ${created.name}`)
      return
    }
    case 'versions': {
      const v = await api<VersionsResponse>(
        values.check ? 'POST' : 'GET',
        values.check ? '/api/platform/versions/check' : '/api/platform/versions'
      )
      table([
        ['COMPONENT', 'VERSION', 'STATE', 'RECOMMENDED', 'LATEST'],
        ...v.components.map((c) => [
          c.id,
          c.version + (c.source === 'default' ? '' : ` (${c.source})`),
          paint(c.activeUpdate ? 'updating' : c.state),
          c.recommended ?? '-',
          c.latest ?? '-',
        ]),
      ])
      console.log(
        v.checkedAt
          ? `\nChecked ${v.checkedAt}${v.checking ? ' (checking again)' : ''}`
          : '\nChecking the registries: run again in a minute, or use --check'
      )
      return
    }
    case 'update': {
      const [, component, version] = positionals
      const queued = values.all
        ? await api<PlatformUpdate[]>(
            'POST',
            '/api/platform/versions/update-all'
          )
        : component && version
          ? [
              await api<PlatformUpdate>(
                'POST',
                `/api/platform/versions/${encodeURIComponent(component)}/update`,
                { version }
              ),
            ]
          : undefined
      if (!queued)
        throw new Error(
          'usage: orbit update <component> <version> | orbit update --all'
        )
      if (!queued.length) return console.log('Nothing to update.')
      for (const u of queued)
        console.log(
          `queued ${u.componentName}: ${u.fromImage ?? '?'} → ${u.toImage} (${u.id})`
        )
      console.log('Follow along in the portal: Versions')
      return
    }
    case 'status': {
      if (!arg) throw new Error('usage: orbit status <name>')
      const app = await api<AppDetail>('GET', `/api/apps/${arg}`)
      console.log(
        `${color.bold}${app.name}${color.reset} (${app.team}) ${paint(app.status)} · template ${app.template} (${app.language})`
      )
      if (app.links.repository) console.log(`repo   ${app.links.repository}`)
      for (const [env, url] of Object.entries(app.links.urls))
        console.log(`${env.padEnd(6)} ${url}`)
      for (const [env, c] of Object.entries(app.cloud)) {
        const parts = [
          c.bucket && `s3://${c.bucket}`,
          c.queueUrl && `sqs ${c.queueUrl}`,
        ]
          .filter(Boolean)
          .join(' · ')
        console.log(
          `${env.padEnd(6)} ${c.provider} ${c.region}: ${parts} ${color.dim}(Secret ${c.secret})${color.reset}`
        )
      }
      console.log()
      if (app.workflows[0]) printWorkflow(app.workflows[0])
      console.log()
      const deps = await api<DeploymentStatus[]>(
        'GET',
        `/api/apps/${arg}/deployments`
      )
      table([
        ['ENV', 'SYNC', 'HEALTH', 'IMAGE', 'MESSAGE'],
        ...deps.map((d) => [
          d.env,
          paint(d.syncStatus),
          paint(d.health),
          d.image ?? '-',
          d.message ?? '',
        ]),
      ])
      return
    }
    case 'watch': {
      if (!arg) throw new Error('usage: orbit watch <name>')
      let last = ''
      for (;;) {
        const app = await api<AppDetail>('GET', `/api/apps/${arg}`)
        const wf = app.workflows[0]
        const snapshot = JSON.stringify(wf?.steps.map((s) => s.status))
        if (wf && snapshot !== last) {
          console.clear()
          printWorkflow(wf)
          last = snapshot
        }
        if (!wf || wf.status === 'succeeded' || wf.status === 'failed') return
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    case 'pipelines': {
      if (!arg) throw new Error('usage: orbit pipelines <name>')
      const list = await api<PipelineSummary[]>(
        'GET',
        `/api/apps/${arg}/pipelines`
      )
      table([
        ['#', 'ID', 'STATUS', 'TRIGGER', 'BRANCH', 'COMMIT'],
        ...list.map((p) => [
          String(p.number),
          p.id,
          paint(p.status),
          p.trigger,
          p.branch,
          `${p.commitSha.slice(0, 8)} ${p.commitMessage ?? ''}`,
        ]),
      ])
      return
    }
    case 'run': {
      if (!arg) throw new Error('usage: orbit run <name>')
      const p = await api<PipelineSummary>('POST', `/api/apps/${arg}/pipelines`)
      console.log(
        `Queued pipeline #${p.number} (${p.id}) for ${p.commitSha.slice(0, 8)}`
      )
      return
    }
    case 'logs': {
      if (!arg)
        throw new Error('usage: orbit logs <pipeline-id> [--stage <name>]')
      const p = await api<PipelineDetail>('GET', `/api/pipelines/${arg}`)
      for (const st of p.stages.filter(
        (s) => !values.stage || s.name === values.stage
      )) {
        console.log(
          `${color.bold}━━ ${st.name} (${st.type}) ${paint(st.status)}${color.reset}${st.error ? ` — ${st.error}` : ''}`
        )
        console.log(st.logs || `${color.dim}(no output)${color.reset}`)
      }
      return
    }
    case 'findings': {
      if (!arg) throw new Error('usage: orbit findings <name>')
      const findings = await api<Finding[]>('GET', `/api/apps/${arg}/findings`)
      if (!findings.length) return console.log('No findings.')
      table([
        ['SEVERITY', 'TOOL', 'TITLE', 'LOCATION'],
        ...findings.map((f) => [
          paint(f.severity),
          `${f.tool}/${f.category}`,
          f.title.slice(0, 70),
          f.location ?? '',
        ]),
      ])
      return
    }
    case 'delete': {
      if (!arg) throw new Error('usage: orbit delete <name> --yes')
      if (!values.yes) {
        console.log(
          `This deletes ${arg}'s repository, namespaces, database, dashboards and deployments. Re-run with --yes.`
        )
        return
      }
      const wf = await api<WorkflowView>('DELETE', `/api/apps/${arg}`)
      console.log(
        `Teardown started (${wf.id}). Follow along: orbit watch ${arg}`
      )
      return
    }
    default:
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(
    `${color.red}error:${color.reset} ${err instanceof Error ? err.message : String(err)}`
  )
  process.exitCode = 1
})
