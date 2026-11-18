import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type * as k8s from '@kubernetes/client-node'
import { parseAllDocuments } from 'yaml'
import type { Platform } from '../../app/platform.js'
import type {
  PlatformUpdateRecord,
  Store,
  VersionOverride,
} from '../../app/store.js'
import { ciImageEnv, DEFAULT_CI_IMAGES, type Config } from '../../config/env.js'
import { HttpProblem } from '../../lib/httpProblem.js'
import { errorMessage } from '../../lib/logger.js'
import { mapLimit, sleep } from '../../lib/util.js'
import type { Kube } from '../../services/kube.js'
import { runJob } from '../../services/jobs.js'
import type {
  ComponentVersion,
  PlatformUpdate,
  PlatformUpdateKind,
  VersionSource,
  VersionsResponse,
} from '../../types/contract.js'
import { ensureScanCache } from '../ci/ci.scanCache.js'
import {
  COMPONENTS,
  componentsFor,
  GROUP_ORDER,
  targetOf,
  type ComponentDef,
} from './versions.catalog.js'
import {
  composeContainers,
  composeDefaults,
  OVERRIDE_FILE,
  overrideImages,
  runCompose,
  runDocker,
  setOverrideImages,
  type ComposeContainer,
} from './versions.compose.js'
import { applyImageOverrides } from './versions.overrides.js'
import { listTags } from './versions.registry.js'
import {
  canonicalImage,
  compareVersions,
  parseImage,
  parseVersion,
  TAG,
  upgrades,
  withTag,
} from './versions.semver.js'

/** Registries are asked again after this long. */
const CHECK_TTL_MS = 6 * 3_600_000
const RECONCILE_MS = 10 * 60_000
const PROBE_MS = 3 * 60_000
const ROLLOUT_MS = 10 * 60_000
const LIST_LOG_CHARS = 4000

const LABELS = { 'app.kubernetes.io/managed-by': 'orbit' }

interface TagInfo {
  tags: string[]
  checkedAt: string
  error?: string
}

interface Current {
  image: string
  running?: string
  source: VersionSource
  defaultImage: string
  manageable: boolean
  reason?: string
}

/** What one GET needs from Docker and Kubernetes, read once. */
interface Snapshot {
  dockerReason?: string
  containers: Map<string, ComposeContainer>
  deployments: Map<string, k8s.V1Deployment | Error>
  nodeImages?: Set<string>
  kubeReason?: string
}

const time = () => new Date().toISOString().slice(11, 19)

/**
 * Platform → Versions: the version of every component, newer releases from
 * their registries, and admin updates, one at a time:
 *
 *   ci       CI/Terraform job images: pulled into the cluster and smoke-tested
 *            by a Job, then used by the next jobs (store + config.images)
 *   compose  docker-compose.yml services: docker pull, the override file,
 *            docker compose up --wait, a probe; rolled back when it fails
 *   kube     Deployments in orbit-system: new image, rollout, probe, rollback;
 *            re-applied when a bootstrap re-applies the manifests
 */
export class VersionManager {
  private readonly tags = new Map<string, TagInfo>()
  private checkedAt?: string
  private checking?: Promise<void>
  private readonly queue: string[] = []
  private working = false
  private reconcileTimer?: NodeJS.Timeout
  private docker?: { at: number; reason: Promise<string | undefined> }
  private lastSnapshot?: { at: number; value: Promise<Snapshot> }

  constructor(private readonly platform: Platform) {
    applyImageOverrides(platform.config, platform.store)
  }

  private get config(): Config {
    return this.platform.config
  }

  private get store(): Store {
    return this.platform.store
  }

  get defs(): ComponentDef[] {
    return componentsFor(this.config.runtime)
  }

  private def(id: string): ComponentDef {
    const def = this.defs.find((d) => d.id === id)
    if (!def) throw new HttpProblem(404, `unknown platform component "${id}"`)
    return def
  }

  start(): void {
    const log = this.platform.log
    const interrupted = this.store.recoverInterruptedPlatformUpdates()
    if (interrupted)
      log.warn(
        `${interrupted} platform update(s) were interrupted by a restart`
      )
    const reconcile = () =>
      this.reconcile().catch((err) =>
        log.warn({ err: errorMessage(err) }, 'version reconcile failed')
      )
    void reconcile()
    this.reconcileTimer = setInterval(() => void reconcile(), RECONCILE_MS)
    this.reconcileTimer.unref()
    if (this.config.components.has('ci'))
      void this.warmCiImages().catch((err) =>
        log.warn({ err: errorMessage(err) }, 'pre-pulling CI images failed')
      )
  }

  stop(): void {
    clearInterval(this.reconcileTimer)
  }

  // ── reading ───────────────────────────────────────────────────────────────

  private dockerReason(): Promise<string | undefined> {
    if (this.docker && Date.now() - this.docker.at < 60_000)
      return this.docker.reason
    const reason = (async () => {
      if (this.config.runtime !== 'compose')
        return 'Orbit runs on kind, not Docker Compose'
      const inContainer = existsSync('/.dockerenv')
      const res = inContainer
        ? undefined
        : await runDocker(['compose', 'version', '--short'], {
            timeoutMs: 10_000,
          })
      if (!res || res.code !== 0)
        return 'Docker is not reachable from the Orbit API (it runs in a container, or Docker is stopped). Run Orbit on the host with npm run dev to change platform services.'
      return undefined
    })()
    this.docker = { at: Date.now(), reason }
    return reason
  }

  /**
   * Docker and Kubernetes state, shared for a few seconds: the Versions page
   * polls, and each read runs docker compose ps. Updates ask for a fresh one.
   */
  private snapshot(fresh = false): Promise<Snapshot> {
    if (!fresh && this.lastSnapshot && Date.now() - this.lastSnapshot.at < 3000)
      return this.lastSnapshot.value
    const value = this.readSnapshot()
    this.lastSnapshot = { at: Date.now(), value }
    return value
  }

  private async readSnapshot(): Promise<Snapshot> {
    const snap: Snapshot = { containers: new Map(), deployments: new Map() }
    const defs = this.defs
    const tasks: Promise<void>[] = []
    if (defs.some((d) => targetOf(d, this.config.runtime) === 'compose')) {
      tasks.push(
        (async () => {
          snap.dockerReason = await this.dockerReason()
          if (snap.dockerReason) return
          try {
            for (const c of await composeContainers(this.config.rootDir))
              snap.containers.set(c.service, c)
          } catch (err) {
            snap.dockerReason = `docker compose ps failed: ${errorMessage(err)}`
          }
        })()
      )
    }
    let kube: Kube | undefined
    try {
      kube = this.platform.kube()
    } catch (err) {
      snap.kubeReason = errorMessage(err)
    }
    if (kube) {
      const k = kube
      for (const d of defs) {
        if (targetOf(d, this.config.runtime) !== 'kube') continue
        tasks.push(
          k.apps
            .readNamespacedDeployment({
              name: d.kube!.deployment,
              namespace: this.config.platformNamespace,
            })
            .then(
              (dep) => void snap.deployments.set(d.id, dep),
              (err: unknown) =>
                void snap.deployments.set(
                  d.id,
                  new Error(
                    `Deployment ${this.config.platformNamespace}/${d.kube!.deployment}: ${errorMessage(err)}`
                  )
                )
            )
        )
      }
      tasks.push(
        k.core.listNode().then(
          (nodes) => {
            snap.nodeImages = new Set(
              nodes.items.flatMap((n) =>
                (n.status?.images ?? []).flatMap((i) => i.names ?? [])
              )
            )
          },
          () => undefined
        )
      )
    }
    await Promise.all(tasks)
    return snap
  }

  private manifestImage(def: ComponentDef): string | undefined {
    const file = path.join(
      this.config.rootDir,
      'bootstrap',
      'manifests',
      def.kube!.manifest
    )
    if (!existsSync(file)) return undefined
    for (const doc of parseAllDocuments(readFileSync(file, 'utf8'))) {
      const o = doc.toJS() as k8s.V1Deployment | null
      if (o?.kind !== 'Deployment' || o.metadata?.name !== def.kube!.deployment)
        continue
      return o.spec?.template.spec?.containers.find(
        (c) => c.name === def.kube!.deployment
      )?.image
    }
    return undefined
  }

  private current(
    def: ComponentDef,
    snap: Snapshot,
    overrides: Map<string, VersionOverride>
  ): Current {
    const target = targetOf(def, this.config.runtime)
    if (target === 'ci') {
      const key = def.ci!.key
      const image = this.config.images[key]
      const defaultImage = DEFAULT_CI_IMAGES[key]
      const fromEnv = process.env[ciImageEnv(key)]
      return {
        image,
        defaultImage,
        source: overrides.has(def.id)
          ? 'admin'
          : fromEnv && fromEnv === image && image !== defaultImage
            ? 'env'
            : 'default',
        manageable: !snap.kubeReason,
        reason: snap.kubeReason,
      }
    }
    if (target === 'compose') {
      const main = def.compose![0]!
      const defaultImage =
        composeDefaults(this.config.rootDir).get(main) ?? 'unknown'
      const override = overrideImages(this.config.rootDir).get(main)
      const image = override ?? defaultImage
      const running = snap.containers.get(main)?.image
      return {
        image,
        running: running && running !== image ? running : undefined,
        defaultImage,
        source: override ? 'admin' : 'default',
        manageable: !snap.dockerReason,
        reason: snap.dockerReason,
      }
    }
    const defaultImage = this.manifestImage(def) ?? 'unknown'
    const override = overrides.get(def.id)?.image
    const dep = snap.deployments.get(def.id)
    const running =
      dep && !(dep instanceof Error)
        ? dep.spec?.template.spec?.containers.find(
            (c) => c.name === def.kube!.deployment
          )?.image
        : undefined
    const image = override ?? running ?? defaultImage
    const reason =
      snap.kubeReason ?? (dep instanceof Error ? dep.message : undefined)
    return {
      image,
      running: running && running !== image ? running : undefined,
      defaultImage,
      source: override ? 'admin' : 'default',
      manageable: !reason,
      reason,
    }
  }

  private describe(
    def: ComponentDef,
    cur: Current,
    snap: Snapshot,
    overrides: Map<string, VersionOverride>,
    active: Map<string, string>
  ): ComponentVersion {
    const info = this.tags.get(def.id)
    const tag = parseImage(cur.image).tag
    const isRelease = parseVersion(tag, def.tags) !== undefined
    const up =
      info && !info.error ? upgrades(cur.image, info.tags, def) : undefined
    const checkError =
      info?.error ??
      (info && !isRelease
        ? `${tag} is not a release tag, so Orbit cannot compare it`
        : undefined)
    return {
      id: def.id,
      name: def.name,
      group: def.group,
      description: def.description,
      image: cur.image,
      version: tag,
      running: cur.running,
      source: cur.source,
      defaultImage: cur.defaultImage,
      previousImage: overrides.get(def.id)?.previousImage,
      latest: up?.latest,
      recommended: up?.recommended,
      candidates: up?.candidates ?? [],
      state:
        !up || checkError
          ? 'unknown'
          : up.recommended
            ? 'update-available'
            : up.latest
              ? 'major-available'
              : 'up-to-date',
      checkedAt: info?.checkedAt,
      checkError,
      manageable: cur.manageable,
      reason: cur.reason,
      downgrade: def.downgrade,
      note: def.note,
      pulled:
        def.ci && snap.nodeImages
          ? snap.nodeImages.has(canonicalImage(cur.image))
          : undefined,
      activeUpdate: active.get(def.id),
    }
  }

  private activeUpdates(): Map<string, string> {
    const active = new Map<string, string>()
    for (const u of this.store.listPlatformUpdates(100))
      if (u.status === 'queued' || u.status === 'running')
        active.set(u.component, u.id)
    return active
  }

  async versions(): Promise<VersionsResponse> {
    const stale =
      !this.checkedAt || Date.now() - Date.parse(this.checkedAt) > CHECK_TTL_MS
    if (stale && !this.checking) void this.check().catch(() => undefined)
    const snap = await this.snapshot()
    const overrides = this.store.versionOverrides()
    const active = this.activeUpdates()
    const order = (d: ComponentDef) => GROUP_ORDER.indexOf(d.group)
    const defs = [...this.defs].sort((a, b) => order(b) - order(a))
    return {
      runtime: this.config.runtime,
      checkedAt: this.checkedAt,
      checking: Boolean(this.checking),
      components: defs.map((d) =>
        this.describe(
          d,
          this.current(d, snap, overrides),
          snap,
          overrides,
          active
        )
      ),
      updates: this.store
        .listPlatformUpdates(20)
        .map((u) => this.updateView(u, LIST_LOG_CHARS)),
    }
  }

  updateView(u: PlatformUpdateRecord, maxLog?: number): PlatformUpdate {
    const logs =
      maxLog && u.logs.length > maxLog
        ? `…\n${u.logs.slice(u.logs.length - maxLog)}`
        : u.logs
    return {
      ...u,
      logs,
      componentName:
        COMPONENTS.find((c) => c.id === u.component)?.name ?? u.component,
    }
  }

  getUpdate(id: string): PlatformUpdate {
    const u = this.store.getPlatformUpdate(id)
    if (!u) throw new HttpProblem(404, `platform update ${id} not found`)
    return this.updateView(u)
  }

  /** Ask every registry for its tags (at most four at a time). */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        const snap = await this.snapshot()
        const overrides = this.store.versionOverrides()
        await mapLimit(this.defs, 4, async (def) => {
          const { image } = this.current(def, snap, overrides)
          const checkedAt = new Date().toISOString()
          try {
            this.tags.set(def.id, { tags: await listTags(image), checkedAt })
          } catch (err) {
            this.tags.set(def.id, {
              tags: [],
              checkedAt,
              error: `could not list tags of ${parseImage(image).name}: ${errorMessage(err)}`,
            })
          }
        })
        this.checkedAt = new Date().toISOString()
      } finally {
        this.checking = undefined
      }
    })()
    return this.checking
  }

  // ── updating ──────────────────────────────────────────────────────────────

  private async prepare(
    def: ComponentDef,
    toImage: string,
    kind: PlatformUpdateKind
  ): Promise<PlatformUpdateRecord> {
    const snap = await this.snapshot(true)
    const cur = this.current(def, snap, this.store.versionOverrides())
    if (!cur.manageable)
      throw new HttpProblem(
        409,
        `${def.name} cannot be changed here: ${cur.reason}`
      )
    const active = this.activeUpdates().get(def.id)
    if (active)
      throw new HttpProblem(
        409,
        `${def.name} already has an update in progress (${active})`
      )
    if (toImage === cur.image && !cur.running)
      throw new HttpProblem(409, `${def.name} already runs ${toImage}`)
    if (def.id === 'k3s') {
      const busy =
        this.store.activePipelines().length +
        this.store.activeWorkflows().length
      if (busy)
        throw new HttpProblem(
          409,
          `${busy} pipeline(s) or workflow(s) are running; updating Kubernetes would interrupt them. Try again when they finish.`
        )
    }
    return this.store.createPlatformUpdate({
      component: def.id,
      kind,
      fromImage: cur.running ?? cur.image,
      toImage,
    })
  }

  /** Queue an update of one component to `version` (a tag of its repository). */
  async requestUpdate(id: string, version: string): Promise<PlatformUpdate> {
    const def = this.def(id)
    if (!TAG.test(version))
      throw new HttpProblem(400, `"${version}" is not a valid image tag`)
    const snap = await this.snapshot(true)
    const cur = this.current(def, snap, this.store.versionOverrides())
    const info = this.tags.get(def.id)
    if (info && !info.error && !info.tags.includes(version))
      throw new HttpProblem(
        400,
        `${parseImage(cur.image).name} has no tag "${version}"`
      )
    const from = parseVersion(parseImage(cur.image).tag, def.tags)
    const to = parseVersion(version, def.tags)
    if (!def.downgrade && from && to && compareVersions(to, from) < 0)
      throw new HttpProblem(
        400,
        `${def.name} cannot be downgraded from ${parseImage(cur.image).tag} to ${version}`
      )
    const op = await this.prepare(def, withTag(cur.image, version), 'update')
    this.enqueue(op.id)
    return this.updateView(op)
  }

  /** Queue a return to the image before the last admin update. */
  async rollback(id: string): Promise<PlatformUpdate> {
    const def = this.def(id)
    if (!def.downgrade)
      throw new HttpProblem(
        400,
        `${def.name} cannot go back to an older version`
      )
    const previous = this.store.versionOverrides().get(def.id)?.previousImage
    if (!previous)
      throw new HttpProblem(
        400,
        `${def.name} has no previous version to go back to`
      )
    const op = await this.prepare(def, previous, 'rollback')
    this.enqueue(op.id)
    return this.updateView(op)
  }

  /** Queue the recommended update of every component that has one. */
  async updateAll(): Promise<PlatformUpdate[]> {
    if (!this.checkedAt) await this.check()
    const { components } = await this.versions()
    const order = (c: ComponentVersion) =>
      GROUP_ORDER.indexOf(c.group) * 10 + (c.id === 'k3s' ? 1 : 0)
    const queued: PlatformUpdate[] = []
    for (const c of [...components].sort((a, b) => order(a) - order(b))) {
      if (!c.recommended || !c.manageable || c.activeUpdate) continue
      try {
        queued.push(await this.requestUpdate(c.id, c.recommended))
      } catch (err) {
        this.platform.log.warn(
          { component: c.id, err: errorMessage(err) },
          'skipped in update-all'
        )
      }
    }
    return queued
  }

  private enqueue(id: string): void {
    this.queue.push(id)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.working) return
    this.working = true
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift())
        await this.run(id)
    } finally {
      this.working = false
    }
  }

  private async run(id: string): Promise<void> {
    const op = this.store.getPlatformUpdate(id)
    if (!op || op.status !== 'queued') return
    const def = this.def(op.component)
    const log = (line: string) =>
      this.store.appendPlatformUpdateLog(id, `[${time()}] ${line}\n`)
    this.store.setPlatformUpdateStatus(id, 'running')
    log(
      `${op.kind === 'rollback' ? 'rolling back' : 'updating'} ${def.name}: ${op.fromImage ?? '?'} → ${op.toImage}`
    )
    try {
      const target = targetOf(def, this.config.runtime)
      if (target === 'ci') await this.applyCi(def, op, log)
      else if (target === 'compose') await this.applyCompose(def, op, log)
      else await this.applyKube(def, op, log)
      this.store.setPlatformUpdateStatus(id, 'succeeded')
      log(`✓ ${def.name} runs ${op.toImage}`)
      this.platform.log.info(
        { component: def.id, image: op.toImage },
        'platform component updated'
      )
    } catch (err) {
      const message = errorMessage(err)
      log(`✗ ${message}`)
      this.store.setPlatformUpdateStatus(id, 'failed', message)
      this.platform.log.warn(
        { component: def.id, image: op.toImage, err: message },
        'platform update failed'
      )
    }
  }

  private async probe(
    def: ComponentDef,
    log: (l: string) => void
  ): Promise<void> {
    if (!def.probe) return
    const deadline = Date.now() + PROBE_MS
    for (;;) {
      try {
        await def.probe(this.platform)
        log(`${def.name} answers`)
        return
      } catch (err) {
        if (Date.now() > deadline)
          throw new Error(`${def.name} does not answer: ${errorMessage(err)}`, {
            cause: err,
          })
        await sleep(5000)
      }
    }
  }

  // ── CI and Terraform job images ───────────────────────────────────────────

  private checkJob(
    def: ComponentDef,
    image: string,
    purpose: string
  ): k8s.V1Job {
    const labels = {
      ...LABELS,
      'orbit.dev/component': 'image-check',
      'orbit.dev/platform-component': def.id,
    }
    const suffix = Date.now().toString(36)
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `orbit-${purpose}-${def.id}-${suffix}`,
        namespace: this.config.ci.namespace,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: this.config.ci.serviceAccount,
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'check',
                image,
                imagePullPolicy: 'IfNotPresent',
                command: def.ci!.smoke,
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { memory: '512Mi' },
                },
              },
            ],
          },
        },
      },
    }
  }

  /** Pull the image into the cluster and run its version command. */
  private async smokeTest(
    def: ComponentDef,
    image: string,
    purpose: string,
    log: (l: string) => void
  ): Promise<string> {
    let lastProgress = Date.now()
    const res = await runJob(this.platform.kube(), {
      namespace: this.config.ci.namespace,
      job: this.checkJob(def, image, purpose),
      timeoutMs: 5 * 60_000,
      onLog: (text) => {
        const waiting = /waiting for image \S+ \((\d+)s so far/.exec(text)
        if (waiting && Date.now() - lastProgress > 30_000) {
          lastProgress = Date.now()
          log(`still downloading ${image} (${waiting[1]}s)`)
        }
      },
    })
    const output = res.lastContainerLog.trim()
    if (!res.succeeded)
      throw new Error(
        `${image} did not pass its check (${res.reason ?? 'failed'})${output ? `: ${output.slice(-500)}` : ''}`
      )
    return output
  }

  private async applyCi(
    def: ComponentDef,
    op: PlatformUpdateRecord,
    log: (l: string) => void
  ): Promise<void> {
    const key = def.ci!.key
    log(
      `pulling ${op.toImage} into the cluster and running "${def.ci!.smoke.join(' ')}"`
    )
    const output = await this.smokeTest(def, op.toImage, 'check', log)
    if (output) log(output.split('\n').slice(0, 5).join('\n'))
    const previous = this.config.images[key]
    this.config.images[key] = op.toImage
    this.store.setVersionOverride(def.id, op.toImage, previous)
    log(`new ${def.name} jobs use ${op.toImage}`)
    if (key === 'trivy') {
      await ensureScanCache(this.platform.kube(), this.config)
      log('CronJob trivy-db now uses the new image')
    }
  }

  /**
   * Download every CI image the node does not have yet, one at a time, so the
   * first pipeline of a new app does not wait for them (ZAP is 1.2 GB).
   */
  private async warmCiImages(): Promise<void> {
    const kube = this.platform.kube()
    const nodes = await kube.core.listNode()
    const present = new Set(
      nodes.items.flatMap((n) =>
        (n.status?.images ?? []).flatMap((i) => i.names ?? [])
      )
    )
    const jobs = await kube.batch.listNamespacedJob({
      namespace: this.config.ci.namespace,
      labelSelector: 'orbit.dev/component=image-check',
    })
    const running = new Set(
      jobs.items
        .filter((j) => !j.status?.succeeded && !j.status?.failed)
        .map((j) => j.metadata?.labels?.['orbit.dev/platform-component'])
    )
    for (const def of this.defs) {
      if (!def.ci || running.has(def.id)) continue
      const image = this.config.images[def.ci.key]
      if (present.has(canonicalImage(image))) continue
      const started = Date.now()
      this.platform.log.info({ image }, 'pre-pulling CI image')
      try {
        await this.smokeTest(def, image, 'pull', () => undefined)
        this.platform.log.info(
          { image, seconds: Math.round((Date.now() - started) / 1000) },
          'CI image ready'
        )
      } catch (err) {
        this.platform.log.warn(
          { image, err: errorMessage(err) },
          'pre-pulling CI image failed'
        )
      }
    }
  }

  // ── Docker Compose services ───────────────────────────────────────────────

  private async composeUp(
    def: ComponentDef,
    log: (l: string) => void
  ): Promise<void> {
    const root = this.config.rootDir
    const [main, ...oneShots] = def.compose!
    const onLine = (l: string) => log(`  ${l}`)
    log(`docker compose up -d --no-deps --wait ${main}`)
    const up = await runCompose(
      root,
      ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '600', main!],
      { onLine, timeoutMs: 15 * 60_000 }
    )
    if (up.code !== 0)
      throw new Error(`docker compose up ${main} failed (exit ${up.code})`)
    for (const s of oneShots) {
      log(`docker compose up --no-deps ${s}`)
      const res = await runCompose(
        root,
        ['up', '--no-deps', '--exit-code-from', s, s],
        { onLine, timeoutMs: 10 * 60_000 }
      )
      if (res.code !== 0)
        throw new Error(`docker compose up ${s} failed (exit ${res.code})`)
    }
  }

  private async applyCompose(
    def: ComponentDef,
    op: PlatformUpdateRecord,
    log: (l: string) => void
  ): Promise<void> {
    const root = this.config.rootDir
    const services = def.compose!
    const previous = overrideImages(root).get(services[0]!)
    const imagesOf = (image: string | undefined) =>
      Object.fromEntries(services.map((s) => [s, image]))

    log(`docker pull ${op.toImage}`)
    const pull = await runDocker(['pull', op.toImage], {
      onLine: (l) => log(`  ${l}`),
      timeoutMs: 60 * 60_000,
    })
    if (pull.code !== 0)
      throw new Error(`docker pull ${op.toImage} failed (exit ${pull.code})`)

    await setOverrideImages(root, imagesOf(op.toImage))
    log(`${OVERRIDE_FILE}: ${services.join(', ')} use ${op.toImage}`)
    try {
      await this.composeUp(def, log)
      await this.probe(def, log)
    } catch (err) {
      const message = errorMessage(err)
      if (!def.downgrade)
        throw new Error(
          `${message}. ${def.name} cannot go back to ${op.fromImage} by itself; see docker compose logs ${services[0]}`,
          { cause: err }
        )
      log(`✗ ${message}; going back to ${op.fromImage}`)
      await setOverrideImages(root, imagesOf(previous))
      await this.composeUp(def, log).catch((e) =>
        log(`✗ going back failed too: ${errorMessage(e)}`)
      )
      throw new Error(`${message} (rolled back to ${op.fromImage})`, {
        cause: err,
      })
    }
    this.store.setVersionOverride(def.id, op.toImage, op.fromImage)
  }

  // ── Deployments in orbit-system ───────────────────────────────────────────

  /** Set the image of the Deployment's container; returns the image it had. */
  private async setDeploymentImage(
    kube: Kube,
    def: ComponentDef,
    image: string
  ): Promise<string | undefined> {
    const name = def.kube!.deployment
    const namespace = this.config.platformNamespace
    const dep = await kube.apps.readNamespacedDeployment({ name, namespace })
    const container = dep.spec?.template.spec?.containers.find(
      (c) => c.name === name
    )
    if (!container)
      throw new Error(
        `Deployment ${namespace}/${name} has no container ${name}`
      )
    const previous = container.image
    if (previous === image) return previous
    container.image = image
    await kube.apps.replaceNamespacedDeployment({ name, namespace, body: dep })
    return previous
  }

  private async waitRollout(
    kube: Kube,
    def: ComponentDef,
    log: (l: string) => void
  ): Promise<void> {
    const name = def.kube!.deployment
    const namespace = this.config.platformNamespace
    const deadline = Date.now() + ROLLOUT_MS
    let badSince: number | undefined
    for (;;) {
      const d = await kube.apps.readNamespacedDeployment({ name, namespace })
      const want = d.spec?.replicas ?? 1
      const s = d.status
      if (
        (s?.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) &&
        (s?.updatedReplicas ?? 0) === want &&
        (s?.availableReplicas ?? 0) === want &&
        !s?.unavailableReplicas
      ) {
        log(`Deployment ${namespace}/${name} rolled out`)
        return
      }
      const selector = Object.entries(d.spec?.selector.matchLabels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      const pods = await kube.core.listNamespacedPod({
        namespace,
        labelSelector: selector,
      })
      const bad = pods.items
        .flatMap((p) => p.status?.containerStatuses ?? [])
        .map((c) => c.state?.waiting?.reason)
        .find((r) =>
          [
            'ErrImagePull',
            'ImagePullBackOff',
            'CrashLoopBackOff',
            'InvalidImageName',
          ].includes(r ?? '')
        )
      if (!bad) badSince = undefined
      else if (badSince === undefined) badSince = Date.now()
      else if (Date.now() - badSince > 90_000)
        throw new Error(`Deployment ${namespace}/${name}: ${bad}`)
      if (Date.now() > deadline)
        throw new Error(
          `Deployment ${namespace}/${name} did not roll out in ${ROLLOUT_MS / 60_000}m`
        )
      await sleep(3000)
    }
  }

  private async applyKube(
    def: ComponentDef,
    op: PlatformUpdateRecord,
    log: (l: string) => void
  ): Promise<void> {
    const kube = this.platform.kube()
    const where = `Deployment ${this.config.platformNamespace}/${def.kube!.deployment}`
    const previous = await this.setDeploymentImage(kube, def, op.toImage)
    log(`${where} → ${op.toImage}`)
    try {
      await this.waitRollout(kube, def, log)
      await this.probe(def, log)
    } catch (err) {
      const message = errorMessage(err)
      if (!def.downgrade || !previous) throw err
      log(`✗ ${message}; going back to ${previous}`)
      await this.setDeploymentImage(kube, def, previous)
      await this.waitRollout(kube, def, log).catch((e) =>
        log(`✗ going back failed too: ${errorMessage(e)}`)
      )
      throw new Error(`${message} (rolled back to ${previous})`, {
        cause: err,
      })
    }
    this.store.setVersionOverride(def.id, op.toImage, previous)
  }

  /**
   * A bootstrap re-applies bootstrap/manifests, which puts the default images
   * back: set the admin's choice again.
   */
  async reconcile(): Promise<void> {
    const overrides = this.store.versionOverrides()
    const active = this.activeUpdates()
    let kube: Kube | undefined
    for (const def of this.defs) {
      if (targetOf(def, this.config.runtime) !== 'kube') continue
      const o = overrides.get(def.id)
      if (!o || active.has(def.id)) continue
      kube ??= this.platform.kube()
      const before = await this.setDeploymentImage(kube, def, o.image)
      if (before !== o.image)
        this.platform.log.info(
          { component: def.id, image: o.image, was: before },
          'image override re-applied'
        )
    }
  }
}
