import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  parsePipeline,
  PIPELINE_FILE,
  type PipelineSpec,
} from '../ci/ci.spec.js'
import {
  APP_SIZES,
  appNamespace,
  appUrl,
  type Config,
} from '../../config/env.js'
import { pushInitialCommit } from '../../services/git.js'
import { isNotFound, upsertSecret } from '../../services/kube.js'
import { errorMessage } from '../../lib/logger.js'
import type { Platform } from '../../app/platform.js'
import type { AppRecord } from '../../app/store.js'
import { shortSha } from '../../lib/util.js'
import { removeApp, writeAppEnvironment } from '../gitops/gitops.files.js'
import { languageName } from '../templates/templates.catalog.js'
import {
  buildAlertRules,
  removeAlertRules,
  rulesKey,
  saveAlertRules,
} from '../observability/observability.alerts.js'
import {
  buildDashboard,
  DASHBOARD_FOLDER,
} from '../observability/observability.dashboards.js'
import { dashboardUid } from '../../config/env.js'
import {
  cloudResources,
  cloudSecretData,
  cloudVars,
  wantsCloud,
} from '../terraform/terraform.cloud.js'
import { runTerraform } from '../terraform/terraform.runner.js'
import type { StepContext, StepDefinition } from './workflow.types.js'

const STATUS_CONTEXT = 'orbit/pipeline'
const org = (config: Config) => config.gitea.appsOrg

/** Append only the new part of a job log that is re-sent in full on every poll. */
function deltaWriter(ctx: StepContext): (full: string) => void {
  let printed = 0
  return (full) => {
    if (full.length < printed) printed = 0 // log was truncated at the head; start over
    if (full.length > printed) {
      ctx.write(full.slice(printed))
      printed = full.length
    }
  }
}

async function loadPipeline(
  platform: Platform,
  app: AppRecord
): Promise<PipelineSpec> {
  const text = await platform.gitea.getRawFile(
    org(platform.config),
    app.name,
    PIPELINE_FILE,
    'main'
  )
  if (!text)
    throw new Error(`${PIPELINE_FILE} was not found on the main branch`)
  const parsed = parsePipeline(text, app.environments)
  if (!parsed.ok)
    throw new Error(`${PIPELINE_FILE} is invalid: ${parsed.errors.join('; ')}`)
  return parsed.spec
}

// 1 ── Git repository ─────────────────────────────────────────────────────────
export const gitRepository: StepDefinition = {
  name: 'git-repository',
  title: 'Create Git repository from template',
  async run({ platform, app, log, setOutputs }) {
    const { gitea, config, templates } = platform
    const owner = org(config)
    let repo = await gitea.getRepo(owner, app.name)
    if (repo) {
      log(`repository ${owner}/${app.name} already exists`)
    } else {
      repo = await gitea.createOrgRepo(
        owner,
        app.name,
        app.description || `${app.name} — team ${app.team}`
      )
      log(`created repository ${repo.full_name}`)
    }
    setOutputs({ repositoryUrl: repo.html_url })

    const main = await gitea.getBranch(owner, app.name, 'main')
    if (main) {
      log(
        `main already has commits (${shortSha(main.commit.id)}); not re-seeding the template`
      )
      return
    }
    const tmpRoot = path.join(config.dataDir, 'tmp')
    await mkdir(tmpRoot, { recursive: true })
    const dir = await mkdtemp(path.join(tmpRoot, `seed-${app.name}-`))
    try {
      const count = await templates.render(
        app.template,
        app.language,
        {
          APP_NAME: app.name,
          TEAM: app.team,
          DESCRIPTION: app.description || `${app.name} service`,
        },
        dir
      )
      const variant = `"${app.template}" (${languageName(app.language)})`
      log(`rendered ${count} files from template ${variant}`)
      const sha = await pushInitialCommit(
        dir,
        platform.repoAuthUrl(`${owner}/${app.name}`),
        `Initial commit from Orbit template ${variant}`
      )
      log(`pushed initial commit ${shortSha(sha)} to main`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  async destroy({ platform, app, log }) {
    await platform.gitea.deleteRepo(org(platform.config), app.name)
    log(`deleted repository ${org(platform.config)}/${app.name}`)
  },
}

// 2 ── CI/CD pipeline ─────────────────────────────────────────────────────────
export const ciPipeline: StepDefinition = {
  name: 'ci-pipeline',
  title: 'Register CI/CD pipeline',
  maxAttempts: 2,
  async run({ platform, app, log, setOutputs }) {
    const { gitea, config, store } = platform
    const spec = await loadPipeline(platform, app)
    log(
      `pipeline: ${spec.stages.map((s) => `${s.name} (${s.type})`).join(' → ')}`
    )
    if (config.webhookUrl && config.webhookSecret) {
      const hook = await gitea.ensurePushHook(
        org(config),
        app.name,
        config.webhookUrl,
        config.webhookSecret
      )
      setOutputs({ webhookId: hook.id })
      log(`push webhook #${hook.id} → ${config.webhookUrl}`)
    } else {
      log(
        'ORBIT_WEBHOOK_URL / ORBIT_WEBHOOK_SECRET not set; relying on branch polling'
      )
    }
    if (config.ci.pollSeconds > 0)
      log(`branch polling fallback every ${config.ci.pollSeconds}s`)
    const head = await gitea.getBranch(org(config), app.name, 'main')
    if (head) store.setBranchHead(app.name, 'main', head.commit.id)
  },
  async destroy({ platform, app, log }) {
    const { gitea, config } = platform
    if (!config.webhookUrl) return
    try {
      const removed = await gitea.deleteHooksTo(
        org(config),
        app.name,
        config.webhookUrl
      )
      log(`removed ${removed} webhook(s)`)
    } catch (err) {
      log(`webhook cleanup skipped: ${errorMessage(err)}`)
    }
  },
}

// 3 ── Terraform ──────────────────────────────────────────────────────────────
// Per environment: app-namespace (Kubernetes), then app-cloud (AWS: Floci locally,
// real AWS in production) when the app asked for object storage or a queue.
// app-cloud's outputs become Secret <app>-aws, which the Deployment loads with envFrom.
export const terraform: StepDefinition = {
  name: 'terraform',
  title:
    'Terraform: namespace, quotas, network policies, database, cloud resources',
  maxAttempts: 2,
  async run(ctx) {
    const { platform, app, log, setOutputs } = ctx
    const { config } = platform
    const size = APP_SIZES[app.options.size] ?? APP_SIZES.small
    const cloud = wantsCloud(app.options)
    if (cloud && config.cloud.provider === 'none') {
      throw new Error(
        'the app requests cloud resources, but ORBIT_CLOUD=none on this platform'
      )
    }
    for (const env of app.environments) {
      const namespace = appNamespace(app.name, env)
      log(
        `terraform apply app-namespace → ${namespace} (quota ${size.cpuQuota} CPU / ${size.memoryQuota}${app.options.database ? ', Postgres' : ''})`
      )
      const outputs = await runTerraform(platform.kube(), config, {
        module: 'app-namespace',
        app: app.name,
        env,
        action: 'apply',
        vars: namespaceVars(app, env, size.cpuQuota, size.memoryQuota),
        onLog: deltaWriter(ctx),
      })
      ctx.write('\n')
      log(`outputs: ${JSON.stringify(outputs)}`)
      setOutputs({
        namespaces: { [env]: String(outputs.namespace ?? namespace) },
      })

      if (!cloud) continue
      const what = [
        app.options.objectStorage && 'S3 bucket',
        app.options.queue && 'SQS queue',
      ]
        .filter(Boolean)
        .join(' + ')
      const where =
        config.cloud.provider === 'floci'
          ? `Floci at ${config.cloud.internalUrl}`
          : `AWS ${config.cloud.region}`
      log(`terraform apply app-cloud → ${what} in ${where}`)
      const cloudOutputs = await runTerraform(platform.kube(), config, {
        module: 'app-cloud',
        app: app.name,
        env,
        action: 'apply',
        vars: cloudVars(config, {
          app: app.name,
          env,
          team: app.team,
          options: app.options,
        }),
        onLog: deltaWriter(ctx),
      })
      ctx.write('\n')
      const resources = cloudResources(config, app.name, cloudOutputs)
      const secretData = cloudSecretData(resources)
      await upsertSecret(
        platform.kube(),
        namespace,
        resources.secret,
        secretData,
        {
          'orbit.dev/app': app.name,
          'orbit.dev/env': env,
        }
      )
      log(
        `Secret ${namespace}/${resources.secret}: ${Object.keys(secretData).join(', ')}`
      )
      setOutputs({ cloud: { [env]: resources } })
    }
  },
  async destroy(ctx) {
    const { platform, app, log } = ctx
    const { config } = platform
    for (const env of [...app.environments].reverse()) {
      if (wantsCloud(app.options)) {
        if (config.cloud.provider === 'none') {
          log(
            `ORBIT_CLOUD=none: skipping app-cloud destroy for ${env}; remove its bucket and queue by hand if they still exist`
          )
        } else {
          log(`terraform destroy app-cloud → ${app.name}/${env}`)
          await runTerraform(platform.kube(), config, {
            module: 'app-cloud',
            app: app.name,
            env,
            action: 'destroy',
            vars: cloudVars(config, {
              app: app.name,
              env,
              team: app.team,
              options: app.options,
            }),
            onLog: deltaWriter(ctx),
          })
          ctx.write('\n')
        }
      }
      log(`terraform destroy app-namespace → ${appNamespace(app.name, env)}`)
      await runTerraform(platform.kube(), config, {
        module: 'app-namespace',
        app: app.name,
        env,
        action: 'destroy',
        vars: namespaceVars(app, env, '1', '1Gi'),
        onLog: deltaWriter(ctx),
      })
      ctx.write('\n')
    }
  },
}

export function namespaceVars(
  app: AppRecord,
  env: string,
  cpuQuota: string,
  memoryQuota: string
): Record<string, string | boolean> {
  return {
    app: app.name,
    env,
    team: app.team,
    namespace: appNamespace(app.name, env),
    cpu_quota: cpuQuota,
    memory_quota: memoryQuota,
    database_enabled: app.options.database,
  }
}

// 4 ── Kubernetes namespace ───────────────────────────────────────────────────
export const kubernetesNamespace: StepDefinition = {
  name: 'kubernetes-namespace',
  title: 'Verify Kubernetes namespaces',
  waitTimeoutMs: 5 * 60_000,
  async run({ platform, app, log }) {
    const kube = platform.kube()
    for (const env of app.environments) {
      const name = appNamespace(app.name, env)
      let ns
      try {
        ns = await kube.core.readNamespace({ name })
      } catch (err) {
        if (isNotFound(err))
          throw new Error(
            `namespace ${name} does not exist after Terraform apply`,
            { cause: err }
          )
        throw err
      }
      if (ns.status?.phase !== 'Active')
        return {
          waitMs: 3000,
          message: `namespace ${name} is ${ns.status?.phase}`,
        }
      const quotas = await kube.core.listNamespacedResourceQuota({
        namespace: name,
      })
      const hard =
        quotas.items[0]?.status?.hard ?? quotas.items[0]?.spec?.hard ?? {}
      const policies =
        ns.metadata?.labels?.['pod-security.kubernetes.io/enforce'] ?? 'none'
      log(
        `${name}: Active · pod security "${policies}" · quota ${hard['limits.cpu'] ?? hard['requests.cpu'] ?? '?'} CPU / ${hard['limits.memory'] ?? hard['requests.memory'] ?? '?'}`
      )
    }
  },
}

// 5 ── GitOps application ─────────────────────────────────────────────────────
export const gitopsApplication: StepDefinition = {
  name: 'gitops-application',
  title: 'Register GitOps application',
  waitTimeoutMs: 3 * 60_000,
  async run({ platform, app, log, state, setOutputs }) {
    const { config, store, events, templates } = platform
    if (!state.committed) {
      const port = templates.get(app.template)?.port ?? 8080
      const { changed, sha } = await platform
        .gitopsWriter()
        .commit(
          `orbit: register ${app.name} (${app.environments.join(', ')})`,
          async (dir) => {
            for (const env of app.environments)
              await writeAppEnvironment(dir, config, app, env, port)
          }
        )
      log(
        changed
          ? `committed ${shortSha(sha)} to ${config.gitea.gitopsRepo}`
          : 'gitops repo already up to date'
      )
      for (const env of app.environments)
        log(
          `apps/${app.name}/${env}/ → namespace ${appNamespace(app.name, env)}`
        )
      setOutputs({
        urls: Object.fromEntries(
          app.environments.map((env) => [env, appUrl(config, app.name, env)])
        ),
      })
      state.committed = true
      events.emit('gitops:sync', {
        app: app.name,
        reason: 'application registered',
      })
    }
    const missing = app.environments.filter(
      (env) => !store.getDeployment(app.name, env)
    )
    if (missing.length) {
      return {
        waitMs: 2000,
        message: `waiting for the GitOps controller to pick up ${missing.join(', ')}`,
      }
    }
    log(
      'GitOps controller is tracking every environment (first sync happens after the first build)'
    )
  },
  async destroy({ platform, app, log }) {
    const { changed, sha } = await platform
      .gitopsWriter()
      .commit(`orbit: remove ${app.name}`, (dir) => removeApp(dir, app.name))
    log(
      changed
        ? `removed apps/${app.name} from the gitops repo (${shortSha(sha)})`
        : 'nothing to remove from the gitops repo'
    )
    platform.events.emit('gitops:sync', {
      app: app.name,
      reason: 'application removed',
    })
  },
}

// 6 ── Security scanning ──────────────────────────────────────────────────────
export const securityPolicy: StepDefinition = {
  name: 'security-policy',
  title: 'Configure security scanning and gate',
  async run({ platform, app, log }) {
    const spec = await loadPipeline(platform, app)
    const scans = spec.stages.filter((s) => s.type === 'scan')
    const dast = spec.stages.filter((s) => s.type === 'dast')
    if (!scans.length)
      log(
        'warning: the pipeline has no scan stage, so the security gate is never evaluated'
      )
    for (const s of scans)
      if (s.type === 'scan')
        log(`scan stage "${s.name}": ${s.scanners.join(', ')}`)
    for (const s of dast)
      if (s.type === 'dast')
        log(
          `DAST stage "${s.name}": OWASP ZAP baseline against ${s.environment}`
        )
    log(
      app.options.securityGate === 'off'
        ? 'security gate: off (findings are reported, never blocking)'
        : `security gate: block on ${app.options.securityGate} or above`
    )
    try {
      const result = await platform.gitea.protectBranch(
        org(platform.config),
        app.name,
        'main',
        STATUS_CONTEXT
      )
      log(
        `branch protection on main: pull requests require "${STATUS_CONTEXT}" (${result})`
      )
    } catch (err) {
      log(`warning: branch protection not configured: ${errorMessage(err)}`)
    }
  },
}

// 7 ── Observability ──────────────────────────────────────────────────────────
export const observability: StepDefinition = {
  name: 'observability',
  title: 'Create Grafana dashboards and Prometheus alerts',
  async run({ platform, app, log, setOutputs }) {
    const { grafana } = platform
    await grafana.ensureFolder(DASHBOARD_FOLDER.uid, DASHBOARD_FOLDER.title)
    const dashboards: Record<string, string> = {}
    for (const env of app.environments) {
      const namespace = appNamespace(app.name, env)
      const { url } = await grafana.upsertDashboard(
        buildDashboard(app.name, env, namespace),
        DASHBOARD_FOLDER.uid
      )
      dashboards[env] = url
      log(`dashboard ${env}: ${url}`)
      const where = await saveAlertRules(
        platform,
        rulesKey(app.name, env),
        buildAlertRules(app.name, env, namespace)
      )
      log(
        `alert rules ${env}: OrbitAppDown, OrbitAppHighErrorRate, OrbitAppHighLatency → ${where}`
      )
    }
    setOutputs({ dashboards })
  },
  async destroy({ platform, app, log }) {
    for (const env of app.environments) {
      await platform.grafana
        .deleteDashboard(dashboardUid(app.name, env))
        .catch((err) => log(`dashboard: ${errorMessage(err)}`))
      await removeAlertRules(platform, rulesKey(app.name, env))
      log(`removed dashboard and alert rules for ${env}`)
    }
  },
}

// 8 ── First pipeline ─────────────────────────────────────────────────────────
export const firstPipeline: StepDefinition = {
  name: 'first-pipeline',
  title: 'Trigger the first pipeline (build → scan → deploy → DAST)',
  async run({ platform, app, log }) {
    const { store, gitea, config, events } = platform
    const existing = store.latestPipeline(app.name)
    if (existing) {
      log(`pipeline #${existing.number} already exists; not triggering another`)
      return
    }
    const head = await gitea.getBranch(org(config), app.name, 'main')
    if (!head) throw new Error('main branch not found')
    const pipeline = store.createPipeline({
      app: app.name,
      commitSha: head.commit.id,
      commitMessage: head.commit.message.split('\n')[0],
      branch: 'main',
      trigger: 'initial',
    })
    store.setBranchHead(app.name, 'main', head.commit.id)
    events.emit('ci:queued', { pipelineId: pipeline.id })
    log(`queued pipeline #${pipeline.number} for ${shortSha(head.commit.id)}`)
  },
  async destroy({ platform, app, log }) {
    platform.events.emit('ci:cancel', { app: app.name })
    const active = platform.store.activePipelines(app.name)
    for (const p of active) {
      if (p.status === 'queued')
        platform.store.updatePipeline(p.id, {
          status: 'canceled',
          finishedAt: new Date().toISOString(),
        })
    }
    log(`canceled ${active.length} active pipeline(s)`)
  },
}

/** The golden path, in order. Teardown runs the destroy() hooks in reverse. */
export const GOLDEN_PATH: StepDefinition[] = [
  gitRepository,
  ciPipeline,
  terraform,
  kubernetesNamespace,
  gitopsApplication,
  securityPolicy,
  observability,
  firstPipeline,
]
