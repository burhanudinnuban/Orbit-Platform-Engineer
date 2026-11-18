import type * as k8s from '@kubernetes/client-node'
import type { PipelineStatus } from '../../types/contract.js'
import { imageRef } from '../../config/env.js'
import { runJob } from '../../services/jobs.js'
import { upsertSecret } from '../../services/kube.js'
import { errorMessage } from '../../lib/logger.js'
import type { Platform } from '../../app/platform.js'
import type { AppRecord, PipelineRecord, StageRecord } from '../../app/store.js'
import { duration, nowIso, shortSha, sleep } from '../../lib/util.js'
import { setImage } from '../gitops/gitops.files.js'
import { parseReport } from '../security/security.parsers.js'
import { evaluatePolicy } from '../security/security.policy.js'
import { extractReports } from '../security/security.reports.js'
import type { RawFinding, ReportTool } from '../security/security.types.js'
import {
  buildJob,
  dastJob,
  dastTarget,
  isTrivy,
  scanJob,
  scriptJob,
  type JobInput,
} from './ci.pods.js'
import { applyImageOverrides } from '../versions/versions.overrides.js'
import { ensureScanCache, TRIVY_DB_CRONJOB } from './ci.scanCache.js'
import {
  parsePipeline,
  PIPELINE_FILE,
  runsOnBranch,
  type StageSpec,
} from './ci.spec.js'

const STATUS_CONTEXT = 'orbit/pipeline'

class StageFailure extends Error {}

/**
 * Orbit CI: picks queued pipelines, runs each stage as a Kubernetes Job (or
 * in-process for deploys), enforces the security gate and reports commit statuses.
 */
export class CiEngine {
  private running = new Map<string, AbortController>()
  private timer?: NodeJS.Timeout
  private pollTimer?: NodeJS.Timeout
  private credentialsReady = false
  private scanCache?: Promise<void>
  private stopped = false

  constructor(private readonly platform: Platform) {}

  start(): void {
    const recovered = this.platform.store.recoverInterruptedPipelines()
    if (recovered)
      this.platform.log.warn(
        { recovered },
        'pipelines interrupted by restart were marked failed'
      )
    // Start fetching Trivy's DB now, so it is there before the first scan.
    this.ensureScanCache().catch((err) =>
      this.platform.log.warn(
        { error: errorMessage(err) },
        'scan cache setup failed; the next pipeline with a Trivy scan retries it'
      )
    )
    this.platform.events.on('ci:queued', () => this.tick())
    this.platform.events.on('ci:cancel', ({ app }) => {
      for (const p of this.platform.store.activePipelines(app))
        this.cancel(p.id)
    })
    const loop = () => {
      if (this.stopped) return
      this.tick()
      this.timer = setTimeout(loop, 2000)
    }
    loop()
    if (this.platform.config.ci.pollSeconds > 0) {
      const poll = () => {
        if (this.stopped) return
        void this.pollBranches().finally(() => {
          this.pollTimer = setTimeout(
            poll,
            this.platform.config.ci.pollSeconds * 1000
          )
        })
      }
      this.pollTimer = setTimeout(poll, 5000)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.pollTimer)
    for (const ctrl of this.running.values())
      ctrl.abort(new Error('platform shutting down'))
  }

  /** Start queued pipelines up to the concurrency limit. */
  tick(): void {
    if (this.stopped) return
    for (const p of this.platform.store.queuedPipelines()) {
      if (this.running.size >= this.platform.config.ci.concurrency) return
      if (this.running.has(p.id)) continue
      // One pipeline at a time per app keeps deploys ordered.
      if (
        [...this.running.keys()].some(
          (id) => this.platform.store.getPipeline(id)?.app === p.app
        )
      )
        continue
      const ctrl = new AbortController()
      this.running.set(p.id, ctrl)
      void this.runPipeline(p, ctrl.signal)
        .catch((err) =>
          this.platform.log.error({ err, pipeline: p.id }, 'pipeline crashed')
        )
        .finally(() => {
          this.running.delete(p.id)
          this.tick()
        })
    }
  }

  cancel(pipelineId: string): PipelineRecord | undefined {
    const { store } = this.platform
    const p = store.getPipeline(pipelineId)
    if (!p) return undefined
    if (p.status === 'queued') {
      store.updatePipeline(p.id, { status: 'canceled', finishedAt: nowIso() })
    } else if (p.status === 'running') {
      this.running.get(p.id)?.abort(new Error('canceled'))
    }
    return store.getPipeline(pipelineId)
  }

  get activeCount(): number {
    return this.running.size
  }

  private async pollBranches(): Promise<void> {
    const { store, gitea, config, events, log } = this.platform
    for (const app of store.listApps().filter((a) => a.status === 'ready')) {
      try {
        const head = await gitea.getBranch(
          config.gitea.appsOrg,
          app.name,
          'main'
        )
        if (!head || store.getBranchHead(app.name, 'main') === head.commit.id)
          continue
        store.setBranchHead(app.name, 'main', head.commit.id)
        if (store.findPipelineByCommit(app.name, head.commit.id, 'main'))
          continue
        const p = store.createPipeline({
          app: app.name,
          commitSha: head.commit.id,
          commitMessage: head.commit.message.split('\n')[0],
          branch: 'main',
          trigger: 'push',
        })
        log.info(
          { app: app.name, sha: shortSha(head.commit.id) },
          'new commit detected by polling'
        )
        events.emit('ci:queued', { pipelineId: p.id })
      } catch (err) {
        log.debug(
          { app: app.name, error: errorMessage(err) },
          'branch poll failed'
        )
      }
    }
  }

  private async ensureCredentials(): Promise<void> {
    if (this.credentialsReady) return
    const { config } = this.platform
    if (!config.gitea.token) throw new Error('GITEA_TOKEN is not set')
    await upsertSecret(
      this.platform.kube(),
      config.ci.namespace,
      config.ci.credentialsSecret,
      {
        username: config.gitea.user,
        token: config.gitea.token,
      }
    )
    this.credentialsReady = true
  }

  /** The shared Trivy DB volume and its refresh CronJob (ci.scanCache.ts); retried after a failure. */
  private ensureScanCache(): Promise<void> {
    const { config, log } = this.platform
    this.scanCache ??= (async () => {
      if (await ensureScanCache(this.platform.kube(), config))
        log.info(
          { job: `${config.ci.namespace}/${TRIVY_DB_CRONJOB}` },
          'downloading the Trivy vulnerability DB in the background'
        )
    })().catch((err: unknown) => {
      this.scanCache = undefined
      throw err
    })
    return this.scanCache
  }

  private async commitStatus(
    p: PipelineRecord,
    state: 'pending' | 'success' | 'failure' | 'error',
    description: string
  ) {
    const { gitea, config, log } = this.platform
    try {
      await gitea.setCommitStatus(config.gitea.appsOrg, p.app, p.commitSha, {
        state,
        description,
        context: STATUS_CONTEXT,
        targetUrl: `${config.portalUrl}/apps/${p.app}?tab=pipelines&run=${p.id}`,
      })
    } catch (err) {
      log.debug({ error: errorMessage(err) }, 'commit status update failed')
    }
  }

  private async runPipeline(
    p: PipelineRecord,
    signal: AbortSignal
  ): Promise<void> {
    const { store, gitea, config, log } = this.platform
    const started = Date.now()
    store.updatePipeline(p.id, { status: 'running', startedAt: nowIso() })
    await this.commitStatus(p, 'pending', `Pipeline #${p.number} running`)
    log.info(
      { app: p.app, pipeline: p.number, sha: shortSha(p.commitSha) },
      'pipeline started'
    )

    let final: PipelineStatus = 'succeeded'
    let error: string | undefined
    try {
      const app = store.getApp(p.app)
      if (!app) throw new Error(`app ${p.app} not found`)
      const text = await gitea.getRawFile(
        config.gitea.appsOrg,
        p.app,
        PIPELINE_FILE,
        p.commitSha
      )
      const parsed = text
        ? parsePipeline(text, app.environments)
        : ({
            ok: false,
            errors: [`${PIPELINE_FILE} not found at this commit`],
          } as const)
      if (!parsed.ok) {
        const [stage] = store.createStages(p.id, [
          { name: 'pipeline-config', type: 'script' },
        ])
        store.updateStage(stage!.id, {
          status: 'failed',
          error: 'invalid pipeline configuration',
          logs: parsed.errors.map((e) => `✗ ${e}`).join('\n'),
          startedAt: nowIso(),
          finishedAt: nowIso(),
        })
        throw new Error(`invalid ${PIPELINE_FILE}`)
      }
      await this.ensureCredentials()
      // Tool versions an admin changed (Platform → Versions), possibly in another process.
      applyImageOverrides(this.platform.config, store)
      const specs = parsed.spec.stages
      if (specs.some((s) => s.type === 'scan' && s.scanners.some(isTrivy)))
        await this.ensureScanCache()
      const stages = store.createStages(
        p.id,
        specs.map((s) => ({ name: s.name, type: s.type }))
      )

      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!
        const stage = stages[i]!
        if (signal.aborted) {
          final = 'canceled'
          break
        }
        if (!runsOnBranch(spec, p.branch)) {
          store.updateStage(stage.id, {
            status: 'skipped',
            logs: `${spec.type} stages only run on the main branch`,
          })
          continue
        }
        store.updateStage(stage.id, { status: 'running', startedAt: nowIso() })
        const stageStarted = Date.now()
        try {
          await this.runStage(app, p, stage, spec, signal)
          store.updateStage(stage.id, {
            status: 'succeeded',
            finishedAt: nowIso(),
          })
          log.info(
            {
              app: p.app,
              pipeline: p.number,
              stage: spec.name,
              took: duration(Date.now() - stageStarted),
            },
            'stage succeeded'
          )
        } catch (err) {
          const canceled = signal.aborted
          store.updateStage(stage.id, {
            status: canceled ? 'canceled' : 'failed',
            error: errorMessage(err),
            finishedAt: nowIso(),
          })
          final = canceled ? 'canceled' : 'failed'
          error = `${spec.name}: ${errorMessage(err)}`
          break
        }
      }
      // Anything left pending is skipped (or canceled).
      for (const st of store.listStages(p.id)) {
        if (st.status === 'pending')
          store.updateStage(st.id, {
            status: final === 'canceled' ? 'canceled' : 'skipped',
          })
      }
    } catch (err) {
      final = signal.aborted ? 'canceled' : 'failed'
      error = errorMessage(err)
    }

    store.updatePipeline(p.id, { status: final, error, finishedAt: nowIso() })
    const took = duration(Date.now() - started)
    await this.commitStatus(
      p,
      final === 'succeeded'
        ? 'success'
        : final === 'canceled'
          ? 'error'
          : 'failure',
      final === 'succeeded'
        ? `Pipeline #${p.number} passed in ${took}`
        : `Pipeline #${p.number} ${final}${error ? `: ${error}` : ''}`
    )
    log.info(
      { app: p.app, pipeline: p.number, status: final, took, error },
      'pipeline finished'
    )
  }

  private async runStage(
    app: AppRecord,
    p: PipelineRecord,
    stage: StageRecord,
    spec: StageSpec,
    signal: AbortSignal
  ): Promise<void> {
    const input: JobInput = { config: this.platform.config, pipeline: p, stage }
    switch (spec.type) {
      case 'script':
        await this.runJobStage(
          stage,
          scriptJob(input, spec),
          signal,
          spec.timeoutMinutes ?? 20
        )
        return
      case 'build':
        await this.runJobStage(
          stage,
          buildJob(input, spec),
          signal,
          spec.timeoutMinutes ?? 30
        )
        return
      case 'scan': {
        const log = await this.runJobStage(
          stage,
          scanJob(input, spec),
          signal,
          spec.timeoutMinutes ?? 20
        )
        return this.applySecurityGate(app, p, stage, spec.scanners, log)
      }
      case 'dast': {
        const log = await this.runJobStage(
          stage,
          dastJob(input, spec),
          signal,
          spec.timeoutMinutes ?? 15,
          [
            `ZAP baseline scan against ${dastTarget(app.name, spec.environment)}`,
          ]
        )
        return this.applySecurityGate(app, p, stage, ['zap'], log)
      }
      case 'deploy':
        return this.deploy(
          app,
          p,
          stage,
          spec.environment,
          signal,
          spec.timeoutMinutes ?? 10
        )
    }
  }

  /** Run a job and mirror its log into the stage. Returns the log of the job's last container. */
  private async runJobStage(
    stage: StageRecord,
    job: k8s.V1Job,
    signal: AbortSignal,
    timeoutMinutes: number,
    preface: string[] = []
  ): Promise<string> {
    const { store, config } = this.platform
    const name = job.metadata!.name!
    const head =
      [...preface, `job ${config.ci.namespace}/${name}`].join('\n') + '\n\n'
    store.updateStage(stage.id, { jobName: name, logs: head })
    const result = await runJob(this.platform.kube(), {
      namespace: config.ci.namespace,
      job,
      timeoutMs: timeoutMinutes * 60_000,
      signal,
      onLog: (log) => store.updateStage(stage.id, { logs: head + log }),
    })
    store.updateStage(stage.id, { logs: head + result.log })
    if (!result.succeeded) throw new StageFailure(result.reason ?? 'job failed')
    return result.lastContainerLog
  }

  private appendStageLog(stage: StageRecord, line: string): void {
    const current =
      this.platform.store
        .listStages(stage.pipelineId)
        .find((s) => s.id === stage.id)?.logs ?? ''
    this.platform.store.updateStage(stage.id, { logs: `${current}${line}\n` })
  }

  private applySecurityGate(
    app: AppRecord,
    p: PipelineRecord,
    stage: StageRecord,
    tools: ReportTool[],
    log: string
  ): void {
    const reports = extractReports(log)
    const missing: string[] = []
    const all: RawFinding[] = []
    for (const tool of tools) {
      const report = reports.find((r) => r.tool === tool)
      if (!report || report.text.trim() === '{}' || !report.text.trim()) {
        missing.push(tool)
        continue
      }
      let findings: RawFinding[]
      try {
        findings = parseReport(tool, report.text)
      } catch (err) {
        missing.push(`${tool} (${errorMessage(err)})`)
        continue
      }
      this.platform.store.replaceFindings(app.name, p.id, tool, findings)
      all.push(...findings)
      this.appendStageLog(stage, `• ${tool}: ${findings.length} finding(s)`)
    }
    const result = evaluatePolicy(all, app.options.securityGate)
    this.appendStageLog(stage, `\nsecurity gate: ${result.summary}`)
    for (const v of result.violations.slice(0, 20)) {
      this.appendStageLog(
        stage,
        `  ✗ [${v.severity}] ${v.tool}: ${v.title}${v.location ? ` — ${v.location}` : ''}`
      )
    }
    if (missing.length) {
      throw new StageFailure(
        `no report from ${missing.join(', ')} — failing closed (see the scanner output above)`
      )
    }
    if (!result.passed) throw new StageFailure(result.summary)
  }

  /** Commit the new image to the gitops repo, then wait for the controller to report Synced + Healthy. */
  private async deploy(
    app: AppRecord,
    p: PipelineRecord,
    stage: StageRecord,
    env: string,
    signal: AbortSignal,
    timeoutMinutes: number
  ) {
    const { store, events, config } = this.platform
    const image = imageRef(config.registry.pull, app.name, p.commitSha)
    this.appendStageLog(stage, `deploying ${image} to ${env}`)
    const { changed, sha } = await this.platform
      .gitopsWriter()
      .commit(
        `deploy ${app.name}@${shortSha(p.commitSha)} to ${env} (pipeline #${p.number})`,
        (dir) => setImage(dir, app.name, env, image, p.commitSha)
      )
    this.appendStageLog(
      stage,
      changed
        ? `committed ${shortSha(sha)} to ${config.gitea.gitopsRepo}`
        : 'gitops repo already points at this image'
    )
    events.emit('gitops:sync', {
      app: app.name,
      reason: `deploy pipeline #${p.number}`,
    })

    const deadline = Date.now() + timeoutMinutes * 60_000
    let last = ''
    while (Date.now() < deadline) {
      const d = store.getDeployment(app.name, env)
      const summary = d
        ? `${d.syncStatus} / ${d.health}${d.message ? ` — ${d.message}` : ''}`
        : 'not tracked yet'
      if (summary !== last) {
        this.appendStageLog(
          stage,
          `[${new Date().toLocaleTimeString()}] ${summary}`
        )
        last = summary
      }
      if (d && d.image === image) {
        if (d.syncStatus === 'Synced' && d.health === 'Healthy') {
          this.appendStageLog(stage, `✓ ${env} is live at ${d.url ?? ''}`)
          return
        }
        if (d.syncStatus === 'Error')
          throw new StageFailure(`sync failed: ${d.message ?? 'unknown error'}`)
        if (d.health === 'Degraded')
          throw new StageFailure(
            `rollout degraded: ${d.message ?? 'unknown reason'}`
          )
      }
      await sleep(2000, signal)
    }
    throw new StageFailure(
      `timed out after ${timeoutMinutes}m waiting for ${env} to become healthy`
    )
  }
}
